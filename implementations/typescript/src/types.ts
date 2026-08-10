/**
 * Type definitions for HIF 1.0.
 *
 * These mirror `specification/hif-1.0.md`. Section references in comments point
 * at the normative text; when the two disagree, the specification wins and the
 * mismatch is a bug here.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** §6.3, §6.6. Two-element `[name, value]`, or `[name, null, base64]` for non-UTF-8 values. */
export type HeaderEntry = [string, string] | [string, null, string];

/** §6.5 */
export type Body =
  | { encoding: 'empty'; contentType?: string; redacted?: boolean }
  | { encoding: 'text'; text: string; contentType?: string; redacted?: boolean }
  | { encoding: 'json'; json: JsonValue; contentType?: string; redacted?: boolean }
  | { encoding: 'base64'; base64: string; contentType?: string; redacted?: boolean };

/** §6 */
export interface HifRequest {
  method: string;
  url: string;
  headers?: HeaderEntry[];
  body?: Body;
}

/** §8 */
export interface HifResponse {
  status: number;
  statusText?: string;
  headers?: HeaderEntry[];
  body?: Body;
}

export type ScalarMatchMode = 'exact' | 'ignore';
export type QueryMatchMode = 'exact' | 'subset' | 'ignore';
export type HeadersMatchMode = 'none' | 'listed' | 'all';
export type BodyMatchMode = 'auto' | 'exact' | 'json' | 'text' | 'ignore';
export type JsonExtraMode = 'reject' | 'allow';

/** §7.1 */
export interface MatchConfig {
  method?: ScalarMatchMode;
  scheme?: ScalarMatchMode;
  host?: ScalarMatchMode;
  port?: ScalarMatchMode;
  path?: ScalarMatchMode;
  query?: { mode?: QueryMatchMode; ignore?: string[] };
  headers?: { mode?: HeadersMatchMode; include?: string[]; ignore?: string[] };
  body?: { mode?: BodyMatchMode; json?: { extra?: JsonExtraMode; ignore?: string[] } };
}

/** A `MatchConfig` with every default filled in. Matching operates on this. */
export interface ResolvedMatchConfig {
  method: ScalarMatchMode;
  scheme: ScalarMatchMode;
  host: ScalarMatchMode;
  port: ScalarMatchMode;
  path: ScalarMatchMode;
  query: { mode: QueryMatchMode; ignore: string[] };
  headers: { mode: HeadersMatchMode; include: string[]; ignore: string[] };
  body: { mode: BodyMatchMode; json: { extra: JsonExtraMode; ignore: string[] } };
}

/** §5.2 */
export interface ReplayConfig {
  times?: number | 'unlimited';
}

/** §5.3 */
export interface Timing {
  latencyMs?: number;
  recordedAt?: string;
}

/** §10 */
export type FaultType =
  | 'connection-refused'
  | 'connection-reset'
  | 'timeout'
  | 'dns-failure'
  | 'tls-error'
  | 'partial-response';

export interface Fault {
  type: FaultType;
  afterMs?: number;
  message?: string;
}

/** §5.4 */
export type ExpectCalled = 'once' | 'atLeastOnce' | 'never' | 'any' | { times: number };

export interface Expect {
  called?: ExpectCalled;
}

/** §5 */
export interface Interaction {
  id?: string;
  request: HifRequest;
  response?: HifResponse;
  match?: MatchConfig;
  replay?: ReplayConfig;
  timing?: Timing;
  fault?: Fault | null;
  expect?: Expect;
  annotations?: Record<string, JsonValue>;
}

/** §3 */
export interface Meta {
  name?: string;
  description?: string;
  createdAt?: string;
  recorder?: { name?: string; version?: string };
  redaction?: { applied?: boolean; rules?: string[] };
  tags?: string[];
}

/** §2 */
export interface Fixture {
  hif: string;
  meta?: Meta;
  defaults?: { match?: MatchConfig; replay?: ReplayConfig };
  interactions: Interaction[];
}

// ---------------------------------------------------------------------------
// Normalized request — the shape matching actually operates on (§6.4)
// ---------------------------------------------------------------------------

export interface QueryParam {
  name: string;
  value: string;
  /** §6.4.1 step 3: a parameter written without `=` at all. */
  valueless: boolean;
}

export interface NormalizedRequest {
  method: string;
  scheme: string;
  host: string;
  /** Effective port after default-port removal, or null when the default applies. */
  port: number | null;
  path: string;
  query: QueryParam[];
  /** Header names lowercased, values OWS-stripped, original order preserved. */
  headers: Array<{ name: string; value: string; binary: boolean }>;
  body: Body;
  /** The normalized URL, without fragment. */
  url: string;
}

// ---------------------------------------------------------------------------
// Mismatch reporting (§13)
// ---------------------------------------------------------------------------

export type MismatchReason =
  | 'value-differs'
  | 'query.missing-param'
  | 'query.unexpected-param'
  | 'query.value-differs'
  | 'header.missing'
  | 'header.unexpected'
  | 'header.value-differs'
  | 'header.count-differs'
  | 'body.encoding-differs'
  | 'body.not-json'
  | 'body.not-text'
  | 'body.bytes-differ'
  | 'body.text-differs'
  | 'json.missing-member'
  | 'json.unexpected-member'
  | 'json.type-differs'
  | 'json.value-differs'
  | 'json.array-length-differs'
  | 'json.placeholder-unsatisfied'
  | 'depleted'
  | 'fault-only';

export type MatchField =
  | 'method'
  | 'scheme'
  | 'host'
  | 'port'
  | 'path'
  | 'query'
  | 'headers'
  | 'body'
  /** Not a compared field: carries the `depleted` reason of §13.3. */
  | 'replay';

export interface FieldResult {
  field: MatchField;
  ok: boolean;
  reason?: MismatchReason;
  /** JSON path (§7.7) or parameter/header name, when the reason has a location. */
  path?: string;
  expected?: JsonValue;
  actual?: JsonValue;
  /** Extra detail lines beyond the first difference, for verbose rendering. */
  details?: FieldResult[];
}

export interface CandidateReport {
  /** `id` when present, else `interactions[<index>]`. */
  ref: string;
  index: number;
  score: number;
  total: number;
  /** True when every compared field matched but the play count is exhausted. */
  depleted: boolean;
  fields: FieldResult[];
}

export interface Suggestion {
  kind: 'match-config';
  target: string;
  value: JsonValue;
  description: string;
  /** Always true. §13.4 forbids emitting an unverified suggestion. */
  verified: true;
}

export interface MismatchReport {
  request: NormalizedRequest;
  candidates: CandidateReport[];
  suggestions: Suggestion[];
  /** True when the fixture had no interactions at all. */
  empty: boolean;
}
