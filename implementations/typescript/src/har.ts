/**
 * HAR to HIF conversion, per specification Appendix B.
 *
 * HAR is a browser network *log*. HIF is a replay specification. The conversion
 * is therefore lossy in both directions, and the honest thing to do is to say
 * exactly what was dropped rather than produce a fixture that looks complete.
 *
 * Every conversion returns a `notes` list. `spool import har` prints it, and
 * nothing here silently discards data.
 */

import { encodeBody } from './body.js';
import { HifStructuralError } from './errors.js';
import { SUPPORTED_VERSION } from './fixture.js';
import type { Fixture, HeaderEntry, Interaction, JsonValue } from './types.js';

export interface HarImportOptions {
  /** Keep only entries whose URL matches this (substring, case-insensitive). */
  filter?: string;
  /** Drop entries served from the browser cache. Default true. */
  skipCached?: boolean;
  /** Record `timing.latencyMs` from HAR's `time`. Default true. */
  keepTiming?: boolean;
  /** Store bodies as text/base64 rather than parsed JSON. */
  preserveBytes?: boolean;
}

export interface HarImportResult {
  fixture: Fixture;
  /** What was dropped or changed. Never empty for a real-world HAR. */
  notes: string[];
  /** Entries in the HAR that produced no interaction, and why. */
  skipped: Array<{ url: string; reason: string }>;
}

interface HarNameValue {
  name?: unknown;
  value?: unknown;
}

/**
 * Convert a HAR 1.2 document into a HIF fixture.
 *
 * The result is deliberately *not* redacted here — HAR files are full of
 * cookies and auth headers, and the caller decides whether to redact, so that
 * the decision is visible at the call site rather than buried in a converter.
 * `spool import har` redacts by default and says so.
 */
export function importHar(document: unknown, options: HarImportOptions = {}): HarImportResult {
  const notes: string[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];

  if (typeof document !== 'object' || document === null) {
    throw new HifStructuralError('HAR document must be a JSON object');
  }
  const log = (document as Record<string, unknown>)['log'];
  if (typeof log !== 'object' || log === null) {
    throw new HifStructuralError('HAR document must have a "log" member');
  }
  const logObj = log as Record<string, unknown>;

  const version = logObj['version'];
  if (typeof version === 'string' && version !== '1.2') {
    notes.push(`HAR version is ${version}; this converter targets 1.2 and may not read every member.`);
  }

  const entries = logObj['entries'];
  if (!Array.isArray(entries)) {
    throw new HifStructuralError('HAR log must have an "entries" array');
  }

  // Appendix B: members with no HIF equivalent.
  if (Array.isArray(logObj['pages']) && logObj['pages'].length > 0) {
    notes.push(`Dropped ${logObj['pages'].length} page record(s): HIF has no page concept.`);
  }
  if (logObj['browser']) notes.push('Dropped "browser": HIF has no equivalent.');
  if (logObj['creator']) notes.push('Dropped "creator": recorded as meta.recorder instead.');

  const interactions: Interaction[] = [];
  let droppedTimings = 0;
  let droppedCache = 0;
  let droppedConnection = 0;
  let cookiesFlattened = 0;
  let contentEncodingDropped = 0;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] as Record<string, unknown> | undefined;
    if (typeof entry !== 'object' || entry === null) {
      skipped.push({ url: `entries[${index}]`, reason: 'not an object' });
      continue;
    }

    const request = entry['request'] as Record<string, unknown> | undefined;
    const response = entry['response'] as Record<string, unknown> | undefined;
    const url = typeof request?.['url'] === 'string' ? request['url'] : `entries[${index}]`;

    if (!request || !response) {
      skipped.push({ url, reason: 'entry has no request or no response' });
      continue;
    }

    if (options.filter && !url.toLowerCase().includes(options.filter.toLowerCase())) {
      skipped.push({ url, reason: `does not match filter ${JSON.stringify(options.filter)}` });
      continue;
    }

    // A cache hit has a synthetic response that was never on the wire, and a
    // status of 0 for an aborted request is not replayable at all.
    const status = typeof response['status'] === 'number' ? response['status'] : 0;
    if (status === 0) {
      skipped.push({ url, reason: 'response status is 0 (request failed or was aborted)' });
      continue;
    }
    if ((options.skipCached ?? true) && isCacheHit(entry)) {
      skipped.push({ url, reason: 'served from the browser cache, so it was never on the wire' });
      continue;
    }

    const scheme = url.split(':', 1)[0]?.toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      skipped.push({ url, reason: `scheme ${scheme ?? '?'} is out of scope for HIF 1.0` });
      continue;
    }

    if (entry['timings']) droppedTimings++;
    if (entry['cache'] && Object.keys(entry['cache'] as object).length > 0) droppedCache++;
    if (entry['connection'] || entry['serverIPAddress']) droppedConnection++;

    const requestHeaders = convertHeaders(request['headers'], request['cookies'], 'cookie');
    const responseHeaders = convertHeaders(response['headers'], response['cookies'], 'set-cookie');
    if (requestHeaders.cookiesFlattened || responseHeaders.cookiesFlattened) cookiesFlattened++;

    // Appendix B / §8.1: a stored body is decoded, so a content-encoding header
    // describing the original compression would be a lie.
    const droppedEncoding = responseHeaders.entries.some(([n]) => n === 'content-encoding');
    if (droppedEncoding) contentEncodingDropped++;

    const interaction: Interaction = {
      request: {
        method: String(request['method'] ?? 'GET').toUpperCase(),
        url: stripFragment(url),
        headers: requestHeaders.entries,
        body: convertPostData(request['postData'], options.preserveBytes ?? false),
      },
      response: {
        status,
        ...(typeof response['statusText'] === 'string' && response['statusText']
          ? { statusText: response['statusText'] }
          : {}),
        headers: responseHeaders.entries.filter(([n]) => n !== 'content-encoding'),
        body: convertContent(response['content'], options.preserveBytes ?? false),
      },
    };

    if ((options.keepTiming ?? true) && typeof entry['time'] === 'number' && entry['time'] >= 0) {
      interaction.timing = { latencyMs: Math.round(entry['time']) };
    }

    interactions.push(interaction);
  }

  if (droppedTimings > 0) {
    notes.push(
      `Collapsed "timings" to timing.latencyMs on ${droppedTimings} entr${droppedTimings === 1 ? 'y' : 'ies'}: ` +
        'the per-phase breakdown (dns, connect, ssl, send, wait, receive) has no HIF equivalent.',
    );
  }
  if (droppedCache > 0) notes.push(`Dropped "cache" on ${droppedCache} entries.`);
  if (droppedConnection > 0) {
    notes.push(`Dropped "connection" and "serverIPAddress" on ${droppedConnection} entries.`);
  }
  if (cookiesFlattened > 0) {
    notes.push(
      `Flattened cookie objects into header fields on ${cookiesFlattened} entries: ` +
        'attributes not present in the raw header (expires, httpOnly, sameSite) are lost.',
    );
  }
  if (contentEncodingDropped > 0) {
    notes.push(
      `Dropped "content-encoding" on ${contentEncodingDropped} response(s): ` +
        'HIF stores decoded bodies, so the header would misdescribe them (spec §8.1).',
    );
  }
  notes.push(
    'HAR defines no matching rules, so every interaction uses the HIF defaults (spec §7.1). ' +
      'A browser-captured HAR usually needs query.ignore for cache-busting parameters.',
  );
  notes.push(
    'HAR performs no redaction. Run redaction over the result before committing it, and read it.',
  );

  const fixture: Fixture = {
    hif: SUPPORTED_VERSION,
    meta: {
      description: 'Imported from a HAR file. See the import notes for what was dropped.',
      recorder: { name: 'spool-typescript (har import)', version: '0.1.0' },
      redaction: { applied: false, rules: [] },
    },
    interactions,
  };

  return { fixture, notes, skipped };
}

function isCacheHit(entry: Record<string, unknown>): boolean {
  const cache = entry['cache'] as Record<string, unknown> | undefined;
  if (cache && typeof cache === 'object' && cache['afterRequest']) return true;
  // A zero-byte transfer with a non-zero body is the other common cache signal.
  const size = entry['_transferSize'] ?? (entry['response'] as Record<string, unknown> | undefined)?.['_transferSize'];
  return size === 0;
}

function convertHeaders(
  raw: unknown,
  cookies: unknown,
  cookieHeader: 'cookie' | 'set-cookie',
): { entries: HeaderEntry[]; cookiesFlattened: boolean } {
  const entries: HeaderEntry[] = [];
  let cookiesFlattened = false;

  if (Array.isArray(raw)) {
    for (const item of raw as HarNameValue[]) {
      if (typeof item?.name !== 'string') continue;
      const name = item.name.toLowerCase();
      // HTTP/2 pseudo-headers are connection metadata, not fields.
      if (name.startsWith(':')) continue;
      entries.push([name, typeof item.value === 'string' ? item.value : String(item.value ?? '')]);
    }
  }

  // Only synthesise a cookie header if the headers array did not already carry
  // one; otherwise the same data would appear twice.
  const hasCookieHeader = entries.some(([n]) => n === cookieHeader);
  if (!hasCookieHeader && Array.isArray(cookies) && cookies.length > 0) {
    cookiesFlattened = true;
    if (cookieHeader === 'cookie') {
      const pairs = (cookies as HarNameValue[])
        .filter((c) => typeof c?.name === 'string')
        .map((c) => `${String(c.name)}=${String(c.value ?? '')}`);
      if (pairs.length > 0) entries.push(['cookie', pairs.join('; ')]);
    } else {
      for (const c of cookies as HarNameValue[]) {
        if (typeof c?.name !== 'string') continue;
        entries.push(['set-cookie', `${c.name}=${String(c.value ?? '')}`]);
      }
    }
  }

  return { entries, cookiesFlattened };
}

function convertPostData(raw: unknown, preserveBytes: boolean) {
  if (typeof raw !== 'object' || raw === null) return { encoding: 'empty' as const };
  const postData = raw as Record<string, unknown>;
  const mimeType = typeof postData['mimeType'] === 'string' ? postData['mimeType'] : undefined;

  if (typeof postData['text'] === 'string') {
    return encodeBody(new TextEncoder().encode(postData['text']), mimeType, { preserveBytes });
  }

  // §6.5: `text` and `params` are mutually exclusive. Reassemble params into a
  // form-encoded body rather than dropping them.
  if (Array.isArray(postData['params'])) {
    const encoded = (postData['params'] as HarNameValue[])
      .filter((p) => typeof p?.name === 'string')
      .map((p) => `${encodeURIComponent(String(p.name))}=${encodeURIComponent(String(p.value ?? ''))}`)
      .join('&');
    return encodeBody(new TextEncoder().encode(encoded), mimeType ?? 'application/x-www-form-urlencoded', {
      preserveBytes,
    });
  }

  return { encoding: 'empty' as const };
}

function convertContent(raw: unknown, preserveBytes: boolean) {
  if (typeof raw !== 'object' || raw === null) return { encoding: 'empty' as const };
  const content = raw as Record<string, unknown>;
  const mimeType = typeof content['mimeType'] === 'string' ? content['mimeType'] : undefined;
  const text = content['text'];
  if (typeof text !== 'string' || text === '') return { encoding: 'empty' as const };

  if (content['encoding'] === 'base64') {
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(text, 'base64'));
    } catch {
      throw new HifStructuralError('HAR content claims base64 encoding but does not decode');
    }
    return encodeBody(bytes, mimeType, { preserveBytes });
  }

  return encodeBody(new TextEncoder().encode(text), mimeType, { preserveBytes });
}

function stripFragment(url: string): string {
  const index = url.indexOf('#');
  return index === -1 ? url : url.slice(0, index);
}

/** Parse and convert in one step, for the CLI. */
export function importHarText(text: string, options: HarImportOptions = {}): HarImportResult {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch (err) {
    throw new HifStructuralError(`HAR file is not valid JSON: ${(err as Error).message}`);
  }
  return importHar(parsed, options);
}
