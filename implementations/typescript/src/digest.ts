/**
 * The `hif-digest-1` request digest, per specification §14.
 *
 * Used for deduplication, cache keys and stable interaction ids. Never used for
 * matching — two requests with the same digest are the same request, but two
 * requests that *match* need not have the same digest, because matching tolerates
 * variance by design.
 *
 * The expected values in `conformance/cases/digest/` are verified against
 * `openssl dgst -sha256`, not against this code.
 */

import { createHash } from 'node:crypto';
import { canonicalize } from './json/canonical.js';
import { decodeBase64 } from './body.js';
import { encodeQuery, normalizeUrl, decodeQuery } from './url.js';
import { normalizeHeaders } from './headers.js';
import type { HifRequest, JsonValue, QueryParam } from './types.js';

/**
 * Build the value that gets canonicalized and hashed (§14).
 *
 * Exposed separately from `digestRequest` so that a failing conformance case can
 * be debugged by looking at the pre-image rather than guessing at a hash.
 */
export function digestPreimage(req: HifRequest): JsonValue {
  const url = normalizeUrl(req.url);

  // §14: query parameters sorted by (name, value) using UTF-16 code unit order.
  const params = [...decodeQuery(url.rawQuery)].sort(compareParams);
  const authority = url.port === null ? url.host : `${url.host}:${url.port}`;
  const query = encodeQuery(params);
  const u = `${url.scheme}://${authority}${url.path}${query === '' ? '' : `?${query}`}`;

  // §14: headers lowercased and sorted by (name, value); repeats produce repeats.
  const headers = normalizeHeaders(req.headers)
    .map((h): [string, string] => [h.name, h.value])
    .sort((a, b) => compareUtf16(a[0], b[0]) || compareUtf16(a[1], b[1]));

  const body = req.body;
  let b: JsonValue;
  if (!body || body.encoding === 'empty') b = null;
  else if (body.encoding === 'text') b = body.text;
  else if (body.encoding === 'json') b = body.json;
  else b = { base64: body.base64 };

  // Single-letter member names so that RFC 8785's name sort produces b, h, m, u
  // in that order, which makes the pre-image readable by hand.
  return { b, h: headers as unknown as JsonValue, m: req.method, u };
}

/** The lowercase hex SHA-256 of the canonical pre-image. */
export function digestRequest(req: HifRequest): string {
  const preimage = canonicalize(digestPreimage(req));
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

/**
 * Validate that a base64 body decodes, and return its byte length.
 * Used by `spool inspect` to report sizes without materialising the bytes twice.
 */
export function base64ByteLength(b64: string): number {
  return decodeBase64(b64).length;
}

function compareParams(a: QueryParam, b: QueryParam): number {
  return compareUtf16(a.name, b.name) || compareUtf16(a.value, b.value);
}

/**
 * UTF-16 code unit ordering.
 *
 * JavaScript's `<` on strings is already UTF-16 code unit ordering, which is
 * what RFC 8785 and §14 specify. `localeCompare` is emphatically not, and using
 * it here would make digests locale-dependent.
 */
function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
