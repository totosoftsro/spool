/**
 * Spool — record and replay HTTP traffic using the portable HIF fixture format.
 *
 * The public API is everything exported here. It follows semantic versioning:
 * a breaking change to any of it requires a major release. Anything not
 * exported from this module is internal and may change in a patch.
 *
 * Quick start:
 *
 * ```ts
 * import { installReplay } from '@spool/hif/fetch';
 * import { readFileSync } from 'node:fs';
 *
 * const spool = installReplay(readFileSync('fixtures/users.hif.json', 'utf8'));
 * try {
 *   await myCodeUnderTest();
 *   spool.assertComplete();
 * } finally {
 *   spool.restore();
 * }
 * ```
 */

export const VERSION = '0.1.0';

// The spec version this implementation targets, and the conformance levels it
// claims. Both are asserted by the conformance suite rather than declared here
// on trust.
export { SUPPORTED_VERSION } from './fixture.js';
export const CONFORMANCE_LEVELS = ['core', 'explain', 'redact', 'full'] as const;

// --- types -----------------------------------------------------------------
export type {
  Body,
  CandidateReport,
  Expect,
  ExpectCalled,
  Fault,
  FaultType,
  FieldResult,
  Fixture,
  HeaderEntry,
  HifRequest,
  HifResponse,
  Interaction,
  JsonValue,
  MatchConfig,
  MatchField,
  Meta,
  MismatchReason,
  MismatchReport,
  NormalizedRequest,
  QueryParam,
  ReplayConfig,
  ResolvedMatchConfig,
  Suggestion,
  Timing,
} from './types.js';

// --- errors ----------------------------------------------------------------
export { HifExpectationError, HifFaultError, HifMatchError, HifStructuralError } from './errors.js';

// --- fixtures --------------------------------------------------------------
export {
  defaultMatchConfig,
  interactionRef,
  parseFixture,
  playLimit,
  resolveMatchConfig,
  serializeFixture,
  validateFixture,
} from './fixture.js';
export type { LoadResult } from './fixture.js';

// --- matching and explanation ----------------------------------------------
export { isMatch, matchRequest, normalizeRequest } from './match.js';
export { explain } from './explain.js';
export type { ExplainInput } from './explain.js';
export { renderMismatch, renderRequest } from './render.js';
export type { RenderOptions } from './render.js';

// --- replay and recording --------------------------------------------------
export { Player, deliverable, faultError } from './player.js';
export type { DeliverableResponse, Play, PlayerOptions } from './player.js';
export { Recorder } from './recorder.js';
export type { CapturedRequest, CapturedResponse, RecorderOptions } from './recorder.js';

// --- redaction -------------------------------------------------------------
export {
  DEFAULT_HEADERS,
  DEFAULT_JSON_FIELDS,
  DEFAULT_QUERY_PARAMS,
  REDACTED,
  entropyTokens,
  redactFixture,
  redactRequest,
  redactResponse,
  scanFixture,
  shannonEntropy,
} from './redact.js';
export type { EntropyConfig, PatternRule, RedactionConfig, RedactionResult, ScanFinding } from './redact.js';

// --- primitives worth exposing ---------------------------------------------
export { canonicalize, canonicalEqual, findLossyNumbers } from './json/canonical.js';
export type { LossyNumber } from './json/canonical.js';
export { formatPath, omitPaths, parsePath, replacePaths, resolvePath } from './json/pointer.js';
export type { PathToken } from './json/pointer.js';
export { digestPreimage, digestRequest } from './digest.js';
export { decodeQuery, encodeQuery, normalizeUrl, removeDotSegments } from './url.js';
export type { ParsedUrl } from './url.js';
export { compilePortableRegex } from './regex.js';
export type { CompiledPattern } from './regex.js';
export {
  isPlaceholder,
  parsePlaceholder,
  parseTextTemplate,
  satisfiesJson,
  satisfiesString,
  stringMatches,
  textMatchesTemplate,
} from './placeholder.js';
export type { Placeholder, TextTemplate } from './placeholder.js';
export { bodyBytes, bodyJson, bodyText, encodeBody, orEmpty } from './body.js';
export type { EncodeOptions } from './body.js';
export { normalizeHeaders, stripOws, toEntries } from './headers.js';
export type { NormalizedHeader } from './headers.js';
