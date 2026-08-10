/**
 * Redaction, per specification §9.
 *
 * Read this before relying on it:
 *
 *   **Redaction reduces exposure. It does not guarantee removal.**
 *
 * Rule-based and entropy-based detection both have false negatives. Nothing in
 * this file may claim otherwise, and nothing it prints should let a reader
 * conclude that a fixture is safe to publish without being read. That is not
 * defensive boilerplate — a recorder that says "sanitized ✓" is actively worse
 * than one that says nothing, because it stops people from looking.
 */

import { canonicalize } from './json/canonical.js';
import { replacePaths } from './json/pointer.js';
import { compilePortableRegex } from './regex.js';
import type { Body, Fixture, HeaderEntry, HifRequest, HifResponse, Interaction, JsonValue } from './types.js';

/** §9.2: the replacement value. Under §7.6 it matches anything, so replay still works. */
export const REDACTED = '{{redacted}}';

/** §9.1 default header field names. */
export const DEFAULT_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'www-authenticate',
  'proxy-authenticate',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-amz-security-token',
  'x-csrf-token',
  'x-xsrf-token',
];

/** §9.1 default query parameter names. */
export const DEFAULT_QUERY_PARAMS: readonly string[] = [
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'code',
  'id_token',
  'password',
  'refresh_token',
  'secret',
  'session',
  'signature',
  'sig',
  'token',
];

/** §9.1 default JSON member names, matched at any depth. */
export const DEFAULT_JSON_FIELDS: readonly string[] = [
  'access_token',
  'api_key',
  'apiKey',
  'authorization',
  'client_secret',
  'credentials',
  'id_token',
  'password',
  'passwd',
  'private_key',
  'refresh_token',
  'secret',
  'session_token',
  'token',
];

export interface PatternRule {
  name: string;
  regex: string;
}

export interface EntropyConfig {
  /** §9.4 defaults to on for header and query values. */
  headersAndQuery?: boolean;
  /** §9.4 defaults to off for text bodies: prose produces false positives. */
  textBodies?: boolean;
  minLength?: number;
  maxLength?: number;
  minBits?: number;
}

export interface RedactionConfig {
  headers?: string[];
  queryParams?: string[];
  jsonFields?: string[];
  jsonPaths?: string[];
  patterns?: PatternRule[];
  entropy?: EntropyConfig | false;
  /** Replace the defaults instead of extending them. Off by default. */
  replaceDefaults?: boolean;
}

export interface RedactionResult<T> {
  value: T;
  /** Rule categories that produced at least one replacement (§9.6). */
  rules: string[];
  /** One line per replacement, for `--verbose` output. Never says "safe". */
  findings: string[];
}

interface Resolved {
  headers: Set<string>;
  queryParams: Set<string>;
  jsonFields: Set<string>;
  jsonPaths: string[];
  patterns: Array<{ name: string; compiled: ReturnType<typeof compilePortableRegex> }>;
  entropy: Required<EntropyConfig> | null;
}

function resolve(config: RedactionConfig = {}): Resolved {
  const lower = (xs: readonly string[]): string[] => xs.map((x) => x.toLowerCase());
  const base = config.replaceDefaults
    ? { headers: [] as string[], queryParams: [] as string[], jsonFields: [] as string[] }
    : {
        headers: lower(DEFAULT_HEADERS),
        queryParams: lower(DEFAULT_QUERY_PARAMS),
        jsonFields: lower(DEFAULT_JSON_FIELDS),
      };

  const entropy: Required<EntropyConfig> | null =
    config.entropy === false
      ? null
      : {
          headersAndQuery: config.entropy?.headersAndQuery ?? true,
          textBodies: config.entropy?.textBodies ?? false,
          minLength: config.entropy?.minLength ?? 24,
          maxLength: config.entropy?.maxLength ?? 512,
          minBits: config.entropy?.minBits ?? 3.5,
        };

  return {
    headers: new Set([...base.headers, ...lower(config.headers ?? [])]),
    queryParams: new Set([...base.queryParams, ...lower(config.queryParams ?? [])]),
    jsonFields: new Set([...base.jsonFields, ...lower(config.jsonFields ?? [])]),
    jsonPaths: config.jsonPaths ?? [],
    patterns: (config.patterns ?? []).map((p) => ({ name: p.name, compiled: compilePortableRegex(p.regex) })),
    entropy,
  };
}

// ---------------------------------------------------------------------------
// Entropy (§9.4)
// ---------------------------------------------------------------------------

/**
 * §9.4 step 1. `=` is not in the splitting alphabet — otherwise
 * `key=AKIAIOSFODNN7EXAMPLE` would be a single token and every `name=value`
 * pair would be glued to its name — but a token absorbs any `=` immediately
 * following it, which is base64 padding.
 */
const TOKEN_PATTERN = /[A-Za-z0-9+/_-]+=*/g;
const CREDENTIAL_SHAPED = /^[A-Za-z0-9+/=_-]+$/;

/** §9.4 step 4: Shannon entropy in bits per character. */
export function shannonEntropy(token: string): number {
  if (token.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  // Sorted so that floating-point summation order is identical everywhere.
  for (const ch of [...counts.keys()].sort()) {
    const p = counts.get(ch)! / token.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** §9.4 steps 1-5. Returns the tokens that qualify as suspected credentials. */
export function entropyTokens(subject: string, cfg: Required<EntropyConfig>): string[] {
  const hits: string[] = [];
  for (const token of subject.match(TOKEN_PATTERN) ?? []) {
    if (token.length < cfg.minLength || token.length > cfg.maxLength) continue;
    if (!CREDENTIAL_SHAPED.test(token)) continue;
    if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) continue;
    if (shannonEntropy(token) >= cfg.minBits) hits.push(token);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/**
 * Redact an entire fixture in place of recording-time redaction.
 *
 * Normally §9 runs during recording so secrets never reach disk. This entry
 * point exists for fixtures that arrived from elsewhere — converted from HAR,
 * hand-written, or recorded before a rule was added (§9.7).
 */
export function redactFixture(fixture: Fixture, config: RedactionConfig = {}): RedactionResult<Fixture> {
  const r = resolve(config);
  const rules = new Set<string>();
  const findings: string[] = [];

  const interactions: Interaction[] = fixture.interactions.map((it, i) => {
    const request = redactRequest(it.request, r, rules, findings, `interactions[${i}].request`);
    const response = it.response ? redactResponse(it.response, r, rules, findings, `interactions[${i}].response`) : undefined;
    return response ? { ...it, request, response } : { ...it, request };
  });

  const value: Fixture = {
    ...fixture,
    meta: {
      ...fixture.meta,
      redaction: { applied: rules.size > 0, rules: [...rules].sort() },
    },
    interactions,
  };

  return { value, rules: [...rules].sort(), findings };
}

export function redactRequest(
  req: HifRequest,
  resolved: Resolved | RedactionConfig,
  rules: Set<string> = new Set(),
  findings: string[] = [],
  at = 'request',
): HifRequest {
  const r = isResolved(resolved) ? resolved : resolve(resolved);
  const out: HifRequest = {
    method: req.method,
    url: redactUrl(req.url, r, rules, findings, at),
  };
  if (req.headers) out.headers = redactHeaders(req.headers, r, rules, findings, at);
  if (req.body) out.body = redactBody(req.body, r, rules, findings, `${at}.body`);
  return out;
}

export function redactResponse(
  res: HifResponse,
  resolved: Resolved | RedactionConfig,
  rules: Set<string> = new Set(),
  findings: string[] = [],
  at = 'response',
): HifResponse {
  const r = isResolved(resolved) ? resolved : resolve(resolved);
  const out: HifResponse = { status: res.status };
  if (res.statusText !== undefined) out.statusText = res.statusText;
  if (res.headers) out.headers = redactHeaders(res.headers, r, rules, findings, at);
  if (res.body) out.body = redactBody(res.body, r, rules, findings, `${at}.body`);
  return out;
}

function isResolved(x: Resolved | RedactionConfig): x is Resolved {
  return x !== null && typeof x === 'object' && 'jsonFields' in x && x.jsonFields instanceof Set;
}

function redactHeaders(
  headers: HeaderEntry[],
  r: Resolved,
  rules: Set<string>,
  findings: string[],
  at: string,
): HeaderEntry[] {
  return headers.map((entry) => {
    const name = String(entry[0]).toLowerCase();
    if (r.headers.has(name)) {
      rules.add('headers');
      findings.push(`${at}: header "${name}" redacted by name rule`);
      return [name, REDACTED];
    }
    // A three-element (non-UTF-8) value is left alone: pattern and entropy rules
    // are defined over text, and guessing at bytes would be unsound.
    if (entry.length === 3 || entry[1] === null) return entry;

    const value = entry[1];
    const patterned = applyPatterns(value, r, rules, findings, `${at}: header "${name}"`);
    const final = applyEntropy(patterned, r, rules, findings, `${at}: header "${name}"`, r.entropy?.headersAndQuery ?? false);
    return final === value ? entry : [name, final];
  });
}

function redactUrl(url: string, r: Resolved, rules: Set<string>, findings: string[], at: string): string {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return url;
  const base = url.slice(0, qIndex);
  const fragmentIndex = url.indexOf('#', qIndex);
  const query = fragmentIndex === -1 ? url.slice(qIndex + 1) : url.slice(qIndex + 1, fragmentIndex);

  const parts = query.split('&').map((segment) => {
    if (segment === '') return segment;
    const eq = segment.indexOf('=');
    if (eq === -1) return segment;
    const rawName = segment.slice(0, eq);
    const name = decodeURIComponent(rawName).toLowerCase();
    const rawValue = segment.slice(eq + 1);

    if (r.queryParams.has(name)) {
      rules.add('queryParams');
      findings.push(`${at}: query parameter "${name}" redacted by name rule`);
      return `${rawName}=${encodeURIComponent(REDACTED)}`;
    }

    let value: string;
    try {
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      return segment;
    }
    const patterned = applyPatterns(value, r, rules, findings, `${at}: query "${name}"`);
    const final = applyEntropy(patterned, r, rules, findings, `${at}: query "${name}"`, r.entropy?.headersAndQuery ?? false);
    return final === value ? segment : `${rawName}=${encodeURIComponent(final)}`;
  });

  return base + '?' + parts.join('&');
}

function redactBody(body: Body, r: Resolved, rules: Set<string>, findings: string[], at: string): Body {
  if (body.encoding === 'empty' || body.encoding === 'base64') return body;

  if (body.encoding === 'json') {
    let json = body.json;
    let changed = false;

    if (r.jsonPaths.length > 0) {
      const res = replacePaths(json, r.jsonPaths, REDACTED);
      if (res.hits > 0) {
        rules.add('jsonPaths');
        findings.push(`${at}: ${res.hits} value(s) redacted by path rule`);
        json = res.value;
        changed = true;
      }
    }

    const byField = redactJsonFields(json, r, rules, findings, at);
    if (byField.changed) {
      json = byField.value;
      changed = true;
    }

    return changed ? { ...body, json, redacted: true } : body;
  }

  // text
  const patterned = applyPatterns(body.text, r, rules, findings, at);
  const final = applyEntropy(patterned, r, rules, findings, at, r.entropy?.textBodies ?? false);
  return final === body.text ? body : { ...body, text: final, redacted: true };
}

function redactJsonFields(
  value: JsonValue,
  r: Resolved,
  rules: Set<string>,
  findings: string[],
  at: string,
): { value: JsonValue; changed: boolean } {
  let changed = false;

  const walk = (node: JsonValue): JsonValue => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') {
      if (typeof node === 'string') {
        const patterned = applyPatterns(node, r, rules, findings, at);
        if (patterned !== node) {
          changed = true;
          return patterned;
        }
      }
      return node;
    }
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(node as Record<string, JsonValue>)) {
      if (r.jsonFields.has(k.toLowerCase())) {
        rules.add('jsonFields');
        findings.push(`${at}: member "${k}" redacted by field-name rule`);
        // §9.2: the member keeps its name and receives the string placeholder,
        // whatever its original type was.
        out[k] = REDACTED;
        changed = true;
        continue;
      }
      out[k] = walk(v);
    }
    return out;
  };

  return { value: walk(value), changed };
}

function applyPatterns(subject: string, r: Resolved, rules: Set<string>, findings: string[], at: string): string {
  let out = subject;
  for (const { name, compiled } of r.patterns) {
    // The §7.6.2 subset is anchored, so patterns are applied per whitespace-
    // delimited token rather than as a global search-and-replace. This keeps
    // pattern semantics identical to placeholder matching.
    const tokens = out.split(/(\s+)/);
    let hit = false;
    const replaced = tokens.map((t) => {
      if (t.trim() === '') return t;
      if (compiled.test(t)) {
        hit = true;
        return REDACTED;
      }
      return t;
    });
    if (hit) {
      rules.add('patterns');
      findings.push(`${at}: matched pattern "${name}"`);
      out = replaced.join('');
    }
  }
  return out;
}

function applyEntropy(
  subject: string,
  r: Resolved,
  rules: Set<string>,
  findings: string[],
  at: string,
  enabled: boolean,
): string {
  if (!enabled || !r.entropy) return subject;
  const hits = entropyTokens(subject, r.entropy);
  if (hits.length === 0) return subject;
  rules.add('entropy');
  let out = subject;
  for (const token of hits) {
    findings.push(`${at}: suspected credential (entropy ${shannonEntropy(token).toFixed(2)} bits/char), redacted`);
    out = out.split(token).join(REDACTED);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scanning (§9.7)
// ---------------------------------------------------------------------------

export interface ScanFinding {
  location: string;
  rule: string;
  /** Always phrased as a suspicion. §9.7 forbids asserting that a value is a secret. */
  note: string;
}

/**
 * Report suspected secrets in an existing fixture without modifying it.
 *
 * Findings are suspicions. An empty result means the rules found nothing, not
 * that the fixture is clean, and the CLI prints exactly that.
 */
export function scanFixture(fixture: Fixture, config: RedactionConfig = {}): ScanFinding[] {
  const r = resolve(config);
  const findings: ScanFinding[] = [];

  fixture.interactions.forEach((it, i) => {
    scanHeaders(it.request.headers, r, `interactions[${i}].request`, findings);
    scanHeaders(it.response?.headers, r, `interactions[${i}].response`, findings);
    scanBody(it.request.body, r, `interactions[${i}].request.body`, findings);
    scanBody(it.response?.body, r, `interactions[${i}].response.body`, findings);
  });

  return findings;
}

function scanHeaders(headers: HeaderEntry[] | undefined, r: Resolved, at: string, out: ScanFinding[]): void {
  for (const entry of headers ?? []) {
    const name = String(entry[0]).toLowerCase();
    const value = entry.length === 3 || entry[1] === null ? null : entry[1];
    if (value === null) continue;
    if (value === REDACTED) continue;
    if (r.headers.has(name)) {
      out.push({ location: `${at}.headers["${name}"]`, rule: 'headers', note: 'header commonly carries a credential and is not redacted' });
      continue;
    }
    if (r.entropy?.headersAndQuery) {
      for (const token of entropyTokens(value, r.entropy)) {
        out.push({
          location: `${at}.headers["${name}"]`,
          rule: 'entropy',
          note: `value looks credential-like (${shannonEntropy(token).toFixed(2)} bits/char)`,
        });
      }
    }
  }
}

function scanBody(body: Body | undefined, r: Resolved, at: string, out: ScanFinding[]): void {
  if (!body) return;
  if (body.encoding === 'json') {
    const text = canonicalize(body.json);
    walkJsonForScan(body.json, [], r, at, out);
    if (r.entropy?.textBodies) {
      for (const token of entropyTokens(text, r.entropy)) {
        out.push({ location: at, rule: 'entropy', note: `body contains a credential-like token (${shannonEntropy(token).toFixed(2)} bits/char)` });
      }
    }
  } else if (body.encoding === 'text' && r.entropy?.textBodies) {
    for (const token of entropyTokens(body.text, r.entropy)) {
      out.push({ location: at, rule: 'entropy', note: `body contains a credential-like token (${shannonEntropy(token).toFixed(2)} bits/char)` });
    }
  }
}

function walkJsonForScan(node: JsonValue, path: string[], r: Resolved, at: string, out: ScanFinding[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkJsonForScan(v, [...path, String(i)], r, at, out));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const key of Object.keys(node as Record<string, JsonValue>).sort()) {
    const value = (node as Record<string, JsonValue>)[key]!;
    if (r.jsonFields.has(key.toLowerCase()) && value !== REDACTED) {
      out.push({
        location: `${at}/${[...path, key].join('/')}`,
        rule: 'jsonFields',
        note: 'member name commonly carries a credential and is not redacted',
      });
    }
    walkJsonForScan(value, [...path, key], r, at, out);
  }
}
