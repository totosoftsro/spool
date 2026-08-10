/**
 * URL normalization and query decomposition, per specification §6.4 and §6.4.1.
 *
 * The steps here are normative and exhaustive. Anything a URL library does that
 * is not on the list is a divergence, which is why this does not simply return
 * `new URL(x).href`: WHATWG URL performs extra normalizations (notably it
 * percent-decodes nothing but re-encodes some characters, and it appends a
 * trailing slash to an empty path) that other languages' URL types do not.
 */

import { HifStructuralError } from './errors.js';
import type { QueryParam } from './types.js';

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

export interface ParsedUrl {
  scheme: string;
  host: string;
  /** null when the port equals the scheme default (§6.4 step 3). */
  port: number | null;
  path: string;
  /** Raw query string, without the leading `?`. Empty string when absent. */
  rawQuery: string;
  /** The reassembled normalized URL, without fragment. */
  href: string;
}

export function normalizeUrl(input: string): ParsedUrl {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new HifStructuralError(`Not an absolute URL: ${JSON.stringify(input)}`);
  }

  // Step 1: scheme lowercased. WHATWG URL already does this.
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new HifStructuralError(`Unsupported URL scheme ${JSON.stringify(scheme)}; HIF 1.0 covers http and https`);
  }

  // Step 2: host lowercased, IDN in A-label form. WHATWG URL does both.
  const host = parsed.hostname.toLowerCase();

  // Step 3: drop the port when it equals the scheme default.
  const rawPort = parsed.port === '' ? DEFAULT_PORTS[scheme]! : Number(parsed.port);
  const port = rawPort === DEFAULT_PORTS[scheme] ? null : rawPort;

  // Steps 4-7 operate on the path. Extract it from the input rather than from
  // `parsed.pathname`, because WHATWG URL has already re-encoded some
  // characters, and step 6 needs to see the original triplets.
  const { rawPath, rawQuery } = split(input, parsed);
  const path = normalizePath(rawPath);

  const authority = port === null ? host : `${host}:${port}`;
  const href = `${scheme}://${authority}${path}${rawQuery === '' ? '' : `?${rawQuery}`}`;

  return { scheme, host, port, path, rawQuery, href };
}

/**
 * Slice the path and query out of the input as written.
 *
 * WHATWG URL's `pathname` and `search` are already partially re-encoded, and
 * §6.4 steps 5-6 need to see the original triplets to decide which to decode.
 * A URL that somehow has no `://` falls back to the parsed values, which is only
 * reachable for inputs `new URL` accepted and this did not.
 */
function split(input: string, parsed: URL): { rawPath: string; rawQuery: string } {
  const schemeEnd = input.indexOf('://');
  if (schemeEnd === -1) {
    return { rawPath: parsed.pathname, rawQuery: parsed.search.replace(/^\?/, '') };
  }
  let i = schemeEnd + 3;
  while (i < input.length && input[i] !== '/' && input[i] !== '?' && input[i] !== '#') i++;

  const fragmentAt = input.indexOf('#', i);
  const beforeFragment = fragmentAt === -1 ? input.slice(i) : input.slice(i, fragmentAt);

  const queryAt = beforeFragment.indexOf('?');
  if (queryAt === -1) return { rawPath: beforeFragment, rawQuery: '' };
  return { rawPath: beforeFragment.slice(0, queryAt), rawQuery: beforeFragment.slice(queryAt + 1) };
}

function normalizePath(rawPath: string): string {
  // Step 4: an empty path becomes "/".
  let path = rawPath === '' ? '/' : rawPath;

  // Steps 5 and 6: uppercase percent triplets, decode unreserved octets.
  path = rewritePercentEncoding(path);

  // Step 7: resolve dot segments per RFC 3986 §5.2.4.
  path = removeDotSegments(path);

  return path === '' ? '/' : path;
}

/**
 * §6.4 steps 5 and 6, applied together in one pass.
 *
 * A triplet whose octet is an RFC 3986 unreserved character is decoded; every
 * other triplet has its hex digits uppercased. A `%` that does not begin a valid
 * triplet is left alone rather than treated as an error, because it appears in
 * real URLs and rejecting it would make recording fail on traffic that works.
 */
export function rewritePercentEncoding(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '%' || i + 2 >= s.length) {
      out += s[i];
      continue;
    }
    const hex = s.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out += s[i];
      continue;
    }
    const code = parseInt(hex, 16);
    const ch = String.fromCharCode(code);
    if (code < 0x80 && UNRESERVED.test(ch)) {
      out += ch;
    } else {
      out += '%' + hex.toUpperCase();
    }
    i += 2;
  }
  return out;
}

/** RFC 3986 §5.2.4, transcribed directly. */
export function removeDotSegments(path: string): string {
  const output: string[] = [];
  let input = path;
  while (input.length > 0) {
    if (input.startsWith('../')) input = input.slice(3);
    else if (input.startsWith('./')) input = input.slice(2);
    else if (input.startsWith('/./')) input = '/' + input.slice(3);
    else if (input === '/.') input = '/';
    else if (input.startsWith('/../')) {
      input = '/' + input.slice(4);
      output.pop();
    } else if (input === '/..') {
      input = '/';
      output.pop();
    } else if (input === '.' || input === '..') {
      input = '';
    } else {
      const nextSlash = input.indexOf('/', 1);
      const segment = nextSlash === -1 ? input : input.slice(0, nextSlash);
      output.push(segment);
      input = nextSlash === -1 ? '' : input.slice(nextSlash);
    }
  }
  return output.join('');
}

/**
 * §6.4.1, transcribed step by step. Notably: split on the *first* `=` only, and
 * a segment with no `=` is valueless, which is distinct from an empty value.
 */
export function decodeQuery(rawQuery: string): QueryParam[] {
  if (rawQuery === '') return [];
  const params: QueryParam[] = [];
  for (const segment of rawQuery.split('&')) {
    if (segment === '') continue;
    const eq = segment.indexOf('=');
    if (eq === -1) {
      params.push({ name: decodeComponent(segment), value: '', valueless: true });
    } else {
      params.push({
        name: decodeComponent(segment.slice(0, eq)),
        value: decodeComponent(segment.slice(eq + 1)),
        valueless: false,
      });
    }
  }
  return params;
}

/** §6.4.1 steps 4 and 5: `+` to space, percent-decode, UTF-8 with U+FFFD replacement. */
function decodeComponent(s: string): string {
  const plussed = s.replace(/\+/g, ' ');
  const bytes: number[] = [];
  for (let i = 0; i < plussed.length; i++) {
    if (plussed[i] === '%' && i + 2 < plussed.length && /^[0-9A-Fa-f]{2}$/.test(plussed.slice(i + 1, i + 3))) {
      bytes.push(parseInt(plussed.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // Non-encoded characters are already text; push their UTF-8 bytes.
      for (const b of new TextEncoder().encode(plussed[i]!)) bytes.push(b);
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
}

/** Re-encode a decoded query parameter list. Used by the digest (§14). */
export function encodeQuery(params: QueryParam[]): string {
  return params
    .map((p) => (p.valueless ? encodeComponent(p.name) : `${encodeComponent(p.name)}=${encodeComponent(p.value)}`))
    .join('&');
}

function encodeComponent(s: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(s)) {
    const ch = String.fromCharCode(byte);
    if (byte < 0x80 && UNRESERVED.test(ch)) out += ch;
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
