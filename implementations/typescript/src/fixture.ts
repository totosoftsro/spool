/**
 * Loading, validating and serializing fixtures, per specification §2, §5, §11.
 *
 * Validation here produces `HifStructuralError`, never a match failure. Keeping
 * the two apart is normative (§11.3) and is the difference between "you have a
 * typo on line 12" and "request did not match".
 */

import { HifStructuralError } from './errors.js';
import { validateBody } from './body.js';
import { normalizeUrl } from './url.js';
import { compilePortableRegex } from './regex.js';
import { parsePath } from './json/pointer.js';
import { parsePlaceholder } from './placeholder.js';
import type {
  Fixture,
  HifRequest,
  HifResponse,
  Interaction,
  JsonValue,
  MatchConfig,
  ResolvedMatchConfig,
} from './types.js';

/** The spec version this implementation targets. */
export const SUPPORTED_VERSION = '1.0';

const SUPPORTED_MAJOR = 1;
const SUPPORTED_MINOR = 0;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);

const FAULT_TYPES = new Set([
  'connection-refused',
  'connection-reset',
  'timeout',
  'dns-failure',
  'tls-error',
  'partial-response',
]);

export interface LoadResult {
  fixture: Fixture;
  /** Non-fatal findings: unknown members, forward-version notices, lint hints. */
  warnings: string[];
}

/** Parse and validate a fixture from JSON text. */
export function parseFixture(text: string, source = '<memory>'): LoadResult {
  let doc: unknown;
  try {
    // §2: a BOM must not be emitted, but must be tolerated on read.
    doc = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new HifStructuralError(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  return validateFixture(doc, source);
}

export function validateFixture(doc: unknown, source = '<memory>'): LoadResult {
  const warnings: string[] = [];

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new HifStructuralError(`${source} must be a JSON object`);
  }
  const d = doc as Record<string, unknown>;

  // §11.2 version handling.
  const version = d['hif'];
  if (typeof version !== 'string') throw new HifStructuralError('Missing required member "hif"');
  const vm = /^(\d+)\.(\d+)$/.exec(version);
  if (!vm) {
    throw new HifStructuralError(`Invalid "hif" version ${JSON.stringify(version)}; expected MAJOR.MINOR`);
  }
  const major = Number(vm[1]);
  const minor = Number(vm[2]);
  if (major !== SUPPORTED_MAJOR) {
    throw new HifStructuralError(
      `Fixture declares HIF ${version}, but this implementation supports ${SUPPORTED_MAJOR}.x. ` +
        'Spec §11.2 requires rejecting a differing major version rather than guessing.',
    );
  }
  if (minor > SUPPORTED_MINOR) {
    warnings.push(
      `Fixture declares HIF ${version}; this implementation targets ${SUPPORTED_VERSION}. ` +
        'Unrecognised members will be ignored (spec §11.2).',
    );
  }

  const interactions = d['interactions'];
  if (!Array.isArray(interactions)) throw new HifStructuralError('Missing required array "interactions"');

  warnUnknown(d, ['hif', 'meta', 'defaults', 'interactions'], '', warnings);

  const defaults = d['defaults'] as Record<string, unknown> | undefined;
  if (defaults !== undefined) {
    if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {
      throw new HifStructuralError('"defaults" must be an object');
    }
    warnUnknown(defaults, ['match', 'replay'], 'defaults', warnings);
    if (defaults['match'] !== undefined) validateMatch(defaults['match'], 'defaults.match', warnings);
    if (defaults['replay'] !== undefined) validateReplay(defaults['replay'], 'defaults.replay', warnings);
  }

  const ids = new Set<string>();
  interactions.forEach((raw, index) => {
    validateInteraction(raw, index, ids, warnings);
  });

  return { fixture: d as unknown as Fixture, warnings };
}

function validateInteraction(raw: unknown, index: number, ids: Set<string>, warnings: string[]): void {
  const at = `interactions[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HifStructuralError('Interaction must be an object', at);
  }
  const it = raw as Record<string, unknown>;
  warnUnknown(
    it,
    ['id', 'request', 'response', 'match', 'replay', 'timing', 'fault', 'expect', 'annotations'],
    at,
    warnings,
  );

  if (it['id'] !== undefined) {
    if (typeof it['id'] !== 'string' || !ID_PATTERN.test(it['id'])) {
      throw new HifStructuralError(`Invalid id ${JSON.stringify(it['id'])}; must match ${ID_PATTERN.source}`, at);
    }
    if (ids.has(it['id'])) throw new HifStructuralError(`Duplicate interaction id ${JSON.stringify(it['id'])}`, at);
    ids.add(it['id']);
  }

  validateRequest(it['request'], `${at}.request`, warnings);

  const fault = it['fault'];
  const hasFault = fault !== undefined && fault !== null;
  const hasResponse = it['response'] !== undefined;

  if (hasFault) validateFault(fault, `${at}.fault`, warnings);
  if (hasResponse) validateResponse(it['response'], `${at}.response`, warnings);

  // §5: exactly one of response / fault, except partial-response which needs both.
  const faultType = hasFault ? (fault as Record<string, unknown>)['type'] : undefined;
  if (!hasFault && !hasResponse) {
    throw new HifStructuralError('Interaction requires a "response" or a non-null "fault"', at);
  }
  if (hasFault && hasResponse && faultType !== 'partial-response') {
    throw new HifStructuralError(
      `Interaction has both a "response" and a "${String(faultType)}" fault; only fault type "partial-response" permits both`,
      at,
    );
  }
  if (faultType === 'partial-response' && !hasResponse) {
    throw new HifStructuralError('Fault type "partial-response" requires a "response" to truncate', at);
  }

  if (it['match'] !== undefined) validateMatch(it['match'], `${at}.match`, warnings);
  if (it['replay'] !== undefined) validateReplay(it['replay'], `${at}.replay`, warnings);
  if (it['timing'] !== undefined) validateTiming(it['timing'], `${at}.timing`, warnings);
  if (it['expect'] !== undefined) validateExpect(it['expect'], `${at}.expect`, warnings);
}

function validateRequest(raw: unknown, at: string, warnings: string[]): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HifStructuralError('Request must be an object', at);
  }
  const req = raw as Record<string, unknown>;
  warnUnknown(req, ['method', 'url', 'headers', 'body'], at, warnings);

  if (typeof req['method'] !== 'string' || req['method'] === '') {
    throw new HifStructuralError('Request requires a non-empty string "method"', at);
  }
  const method = req['method'];
  if (method !== method.toUpperCase() && KNOWN_METHODS.has(method.toUpperCase())) {
    // §6.1 requires linters to flag this: a lowercase known method silently
    // fails to match live traffic.
    warnings.push(
      `${at}: method ${JSON.stringify(method)} is a known method stored in lowercase; ` +
        'spec §6.1 requires uppercase and this will not match live requests.',
    );
  }

  if (typeof req['url'] !== 'string') throw new HifStructuralError('Request requires a string "url"', at);
  normalizeUrl(req['url']);
  if (req['url'].includes('#')) {
    warnings.push(`${at}: url contains a fragment, which spec §6.2 says must not be stored; it will be ignored.`);
  }

  validateHeaderList(req['headers'], `${at}.headers`);
  if (req['body'] !== undefined) validateBody(req['body'], `${at}.body`);
  checkPlaceholders(req['body'], `${at}.body`);
}

function validateResponse(raw: unknown, at: string, warnings: string[]): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HifStructuralError('Response must be an object', at);
  }
  const res = raw as Record<string, unknown>;
  warnUnknown(res, ['status', 'statusText', 'headers', 'body'], at, warnings);

  const status = res['status'];
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new HifStructuralError(`Response "status" must be an integer in 100..599, got ${JSON.stringify(status)}`, at);
  }
  validateHeaderList(res['headers'], `${at}.headers`);
  if (res['body'] !== undefined) validateBody(res['body'], `${at}.body`);
}

function validateHeaderList(raw: unknown, at: string): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) throw new HifStructuralError('Headers must be an array of entries', at);
  raw.forEach((entry, i) => {
    if (!Array.isArray(entry) || (entry.length !== 2 && entry.length !== 3)) {
      throw new HifStructuralError('Header entry must be [name, value] or [name, null, base64]', `${at}[${i}]`);
    }
    if (typeof entry[0] !== 'string') throw new HifStructuralError('Header name must be a string', `${at}[${i}]`);
    if (entry.length === 2 && typeof entry[1] !== 'string') {
      throw new HifStructuralError('Header value must be a string', `${at}[${i}]`);
    }
    if (entry.length === 3 && (entry[1] !== null || typeof entry[2] !== 'string')) {
      throw new HifStructuralError('A three-element header entry must be [name, null, base64]', `${at}[${i}]`);
    }
  });
}

/**
 * Compile every `{{regex:…}}` found in a recorded body so that an invalid
 * pattern is a load-time structural error rather than a surprise at match time
 * (§7.6.2, §11.3).
 */
function checkPlaceholders(body: unknown, at: string): void {
  if (typeof body !== 'object' || body === null) return;
  const b = body as Record<string, unknown>;
  if (b['encoding'] === 'json') walkJson(b['json'] as JsonValue, at);
  if (b['encoding'] === 'text' && typeof b['text'] === 'string') checkString(b['text'], at);
}

function walkJson(value: JsonValue, at: string): void {
  if (typeof value === 'string') {
    const ph = parsePlaceholder(value);
    if (ph?.kind === 'regex') compilePortableRegex(ph.pattern);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => walkJson(v, at));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) walkJson(v, at);
  }
}

function checkString(text: string, at: string): void {
  for (const m of text.matchAll(/\{\{regex:((?:[^}]|\}(?!\}))*)\}\}/g)) {
    try {
      compilePortableRegex(m[1]!);
    } catch (err) {
      throw new HifStructuralError((err as Error).message, at);
    }
  }
}

function validateMatch(raw: unknown, at: string, warnings: string[]): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HifStructuralError('"match" must be an object', at);
  }
  const m = raw as Record<string, unknown>;
  warnUnknown(m, ['method', 'scheme', 'host', 'port', 'path', 'query', 'headers', 'body'], at, warnings);

  for (const field of ['method', 'scheme', 'host', 'port', 'path'] as const) {
    const v = m[field];
    if (v !== undefined && v !== 'exact' && v !== 'ignore') {
      throw new HifStructuralError(`match.${field} must be "exact" or "ignore", got ${JSON.stringify(v)}`, at);
    }
  }

  const query = m['query'] as Record<string, unknown> | undefined;
  if (query !== undefined) {
    requireObject(query, `${at}.query`);
    warnUnknown(query, ['mode', 'ignore'], `${at}.query`, warnings);
    requireEnum(query['mode'], ['exact', 'subset', 'ignore'], `${at}.query.mode`);
    requireStringArray(query['ignore'], `${at}.query.ignore`);
  }

  const headers = m['headers'] as Record<string, unknown> | undefined;
  if (headers !== undefined) {
    requireObject(headers, `${at}.headers`);
    warnUnknown(headers, ['mode', 'include', 'ignore'], `${at}.headers`, warnings);
    requireEnum(headers['mode'], ['none', 'listed', 'all'], `${at}.headers.mode`);
    requireStringArray(headers['include'], `${at}.headers.include`);
    requireStringArray(headers['ignore'], `${at}.headers.ignore`);
    if (headers['mode'] === 'listed' && (headers['include'] as unknown[] | undefined)?.length === 0) {
      warnings.push(`${at}.headers: mode is "listed" with an empty "include", so no header is compared.`);
    }
  }

  const body = m['body'] as Record<string, unknown> | undefined;
  if (body !== undefined) {
    requireObject(body, `${at}.body`);
    warnUnknown(body, ['mode', 'json'], `${at}.body`, warnings);
    requireEnum(body['mode'], ['auto', 'exact', 'json', 'text', 'ignore'], `${at}.body.mode`);
    const json = body['json'] as Record<string, unknown> | undefined;
    if (json !== undefined) {
      requireObject(json, `${at}.body.json`);
      warnUnknown(json, ['extra', 'ignore'], `${at}.body.json`, warnings);
      requireEnum(json['extra'], ['reject', 'allow'], `${at}.body.json.extra`);
      requireStringArray(json['ignore'], `${at}.body.json.ignore`);
      for (const p of (json['ignore'] as string[] | undefined) ?? []) parsePath(p);
    }
  }
}

function validateReplay(raw: unknown, at: string, warnings: string[]): void {
  requireObject(raw, at);
  const r = raw as Record<string, unknown>;
  warnUnknown(r, ['times'], at, warnings);
  const times = r['times'];
  if (times === undefined) return;
  if (times === 'unlimited') return;
  if (typeof times !== 'number' || !Number.isInteger(times) || times < 1) {
    throw new HifStructuralError(`replay.times must be a positive integer or "unlimited", got ${JSON.stringify(times)}`, at);
  }
}

function validateTiming(raw: unknown, at: string, warnings: string[]): void {
  requireObject(raw, at);
  const t = raw as Record<string, unknown>;
  warnUnknown(t, ['latencyMs', 'recordedAt'], at, warnings);
  if (t['latencyMs'] !== undefined && (typeof t['latencyMs'] !== 'number' || t['latencyMs'] < 0)) {
    throw new HifStructuralError('timing.latencyMs must be a number >= 0', at);
  }
}

function validateFault(raw: unknown, at: string, warnings: string[]): void {
  requireObject(raw, at);
  const f = raw as Record<string, unknown>;
  warnUnknown(f, ['type', 'afterMs', 'message'], at, warnings);
  if (typeof f['type'] !== 'string' || !FAULT_TYPES.has(f['type'])) {
    throw new HifStructuralError(
      `Unknown fault type ${JSON.stringify(f['type'])}; expected one of ${[...FAULT_TYPES].join(', ')}`,
      at,
    );
  }
  if (f['afterMs'] !== undefined && (typeof f['afterMs'] !== 'number' || f['afterMs'] < 0)) {
    throw new HifStructuralError('fault.afterMs must be a number >= 0', at);
  }
}

function validateExpect(raw: unknown, at: string, warnings: string[]): void {
  requireObject(raw, at);
  const e = raw as Record<string, unknown>;
  warnUnknown(e, ['called'], at, warnings);
  const called = e['called'];
  if (called === undefined) return;
  if (typeof called === 'string') {
    requireEnum(called, ['once', 'atLeastOnce', 'never', 'any'], `${at}.called`);
    return;
  }
  requireObject(called, `${at}.called`);
  const times = (called as Record<string, unknown>)['times'];
  if (typeof times !== 'number' || !Number.isInteger(times) || times < 0) {
    throw new HifStructuralError('expect.called.times must be a non-negative integer', at);
  }
}

// --- small validation helpers ---------------------------------------------

function requireObject(raw: unknown, at: string): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HifStructuralError('Expected an object', at);
  }
}

function requireEnum(value: unknown, allowed: string[], at: string): void {
  if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) {
    throw new HifStructuralError(`Expected one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}, got ${JSON.stringify(value)}`, at);
  }
}

function requireStringArray(value: unknown, at: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new HifStructuralError('Expected an array of strings', at);
  }
}

/**
 * §2.1: unknown members are ignored, not rejected — but reported, because the
 * usual cause is a misspelled key in a `match` block that silently does nothing.
 */
function warnUnknown(obj: Record<string, unknown>, known: string[], at: string, warnings: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      warnings.push(`${at ? at + '.' : ''}${key}: unknown member, ignored. Did you mean one of ${known.join(', ')}?`);
    }
  }
}

// ---------------------------------------------------------------------------
// Effective configuration
// ---------------------------------------------------------------------------

/** §7.1 defaults, spelled out. */
export function defaultMatchConfig(): ResolvedMatchConfig {
  return {
    method: 'exact',
    scheme: 'exact',
    host: 'exact',
    port: 'exact',
    path: 'exact',
    query: { mode: 'exact', ignore: [] },
    headers: { mode: 'none', include: [], ignore: [] },
    body: { mode: 'auto', json: { extra: 'reject', ignore: [] } },
  };
}

/**
 * §4: merging is shallow per named sub-object. `defaults.match.query` is
 * replaced wholesale by `interaction.match.query`, not deep merged, so the
 * effective configuration is readable from at most two places.
 */
export function resolveMatchConfig(fixtureDefaults?: MatchConfig, interaction?: MatchConfig): ResolvedMatchConfig {
  const base = defaultMatchConfig();
  const layer = (m: MatchConfig | undefined): void => {
    if (!m) return;
    if (m.method) base.method = m.method;
    if (m.scheme) base.scheme = m.scheme;
    if (m.host) base.host = m.host;
    if (m.port) base.port = m.port;
    if (m.path) base.path = m.path;
    if (m.query) base.query = { mode: m.query.mode ?? 'exact', ignore: m.query.ignore ?? [] };
    if (m.headers) {
      base.headers = {
        mode: m.headers.mode ?? 'none',
        include: m.headers.include ?? [],
        ignore: m.headers.ignore ?? [],
      };
    }
    if (m.body) {
      base.body = {
        mode: m.body.mode ?? 'auto',
        json: { extra: m.body.json?.extra ?? 'reject', ignore: m.body.json?.ignore ?? [] },
      };
    }
  };
  layer(fixtureDefaults);
  layer(interaction);
  return base;
}

/** Total play count for an interaction (§5.2). */
export function playLimit(fixture: Fixture, interaction: Interaction): number | 'unlimited' {
  const times = interaction.replay?.times ?? fixture.defaults?.replay?.times ?? 1;
  return times;
}

/** Diagnostic reference for an interaction (§5.1). */
export function interactionRef(interaction: Interaction, index: number): string {
  return interaction.id ?? `interactions[${index}]`;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a fixture for storage.
 *
 * Two-space indentation with a trailing newline, because fixtures live in git
 * and are read in pull requests. Member order follows the spec's presentation
 * order rather than insertion order, so that a re-record produces a minimal diff.
 */
export function serializeFixture(fixture: Fixture): string {
  const ordered: Record<string, unknown> = { hif: fixture.hif };
  if (fixture.meta) ordered['meta'] = fixture.meta;
  if (fixture.defaults) ordered['defaults'] = fixture.defaults;
  ordered['interactions'] = fixture.interactions.map(orderInteraction);
  return JSON.stringify(ordered, null, 2) + '\n';
}

function orderInteraction(it: Interaction): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (it.id !== undefined) out['id'] = it.id;
  out['request'] = orderRequest(it.request);
  if (it.response !== undefined) out['response'] = orderResponse(it.response);
  if (it.fault !== undefined && it.fault !== null) out['fault'] = it.fault;
  if (it.match !== undefined) out['match'] = it.match;
  if (it.replay !== undefined) out['replay'] = it.replay;
  if (it.timing !== undefined) out['timing'] = it.timing;
  if (it.expect !== undefined) out['expect'] = it.expect;
  if (it.annotations !== undefined) out['annotations'] = it.annotations;
  return out;
}

function orderRequest(r: HifRequest): Record<string, unknown> {
  const out: Record<string, unknown> = { method: r.method, url: r.url };
  if (r.headers?.length) out['headers'] = r.headers;
  if (r.body && r.body.encoding !== 'empty') out['body'] = r.body;
  return out;
}

function orderResponse(r: HifResponse): Record<string, unknown> {
  const out: Record<string, unknown> = { status: r.status };
  if (r.statusText !== undefined) out['statusText'] = r.statusText;
  if (r.headers?.length) out['headers'] = r.headers;
  if (r.body && r.body.encoding !== 'empty') out['body'] = r.body;
  return out;
}
