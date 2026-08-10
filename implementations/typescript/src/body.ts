/**
 * Body encoding and decoding, per specification §6.5.
 */

import { HifStructuralError } from './errors.js';
import { canonicalize, findLossyNumbers } from './json/canonical.js';
import type { Body, JsonValue } from './types.js';

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const EMPTY_BODY: Body = { encoding: 'empty' };

/** §6.5: an absent body and `{ encoding: "empty" }` are the same thing. */
export function orEmpty(body: Body | undefined): Body {
  return body ?? EMPTY_BODY;
}

export function decodeBase64(b64: string, at?: string): Uint8Array {
  if (!BASE64.test(b64) || b64.length % 4 !== 0) {
    throw new HifStructuralError(
      'Invalid base64: the standard RFC 4648 §4 alphabet with padding is required, and whitespace is not permitted',
      at,
    );
  }
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Reduce a body to its bytes, as §7.4.1 requires for `exact` comparison. */
export function bodyBytes(body: Body): Uint8Array {
  switch (body.encoding) {
    case 'empty':
      return new Uint8Array(0);
    case 'text':
      return new TextEncoder().encode(body.text);
    case 'json':
      return new TextEncoder().encode(canonicalize(body.json));
    case 'base64':
      return decodeBase64(body.base64);
  }
}

/** Reduce a body to text, or null when it cannot be represented as text (§7.4.3). */
export function bodyText(body: Body): string | null {
  switch (body.encoding) {
    case 'empty':
      return '';
    case 'text':
      return body.text;
    case 'json':
      return canonicalize(body.json);
    case 'base64':
      // A body stored as base64 because it is not valid UTF-8 has no text form.
      return decodeUtf8Strict(decodeBase64(body.base64));
  }
}

/** Reduce a body to a JSON value, or null when it does not parse (§7.4.2). */
export function bodyJson(body: Body): { ok: true; value: JsonValue } | { ok: false } {
  if (body.encoding === 'json') return { ok: true, value: body.json };
  const text = bodyText(body);
  if (text === null) return { ok: false };
  if (text.trim() === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch {
    return { ok: false };
  }
}

export interface EncodeOptions {
  /**
   * Never use the `json` encoding, even for JSON bodies. §6.5.2: required when
   * the caller needs byte-exact preservation.
   */
  preserveBytes?: boolean;
  /** Collects §12.3 round-trip warnings rather than throwing. */
  onWarning?: (message: string) => void;
}

/**
 * §6.5.1: choose an encoding for raw body bytes.
 *
 * The procedure is normative and ordered. Step 2 is deliberately conservative —
 * a body that claims to be JSON but does not parse is stored as text, so the
 * fixture preserves what was on the wire rather than failing to record.
 */
export function encodeBody(bytes: Uint8Array, contentType?: string, options: EncodeOptions = {}): Body {
  if (bytes.length === 0) {
    return contentType ? { encoding: 'empty', contentType } : EMPTY_BODY;
  }

  const text = decodeUtf8Strict(bytes);

  if (text !== null && !options.preserveBytes && isJsonMediaType(contentType)) {
    try {
      const parsed = JSON.parse(text) as JsonValue;
      const lossy = findLossyNumbers(text);
      if (lossy.length > 0) {
        // §12.3: warn and fall back to text rather than silently corrupting a
        // 64-bit identifier.
        const detail = lossy.map((l) => `${l.literal} would become ${l.canonical}`).join(', ');
        options.onWarning?.(
          `Body stored as text instead of json: ${lossy.length} number literal(s) do not survive an IEEE 754 round trip (${detail}). See spec §12.3.`,
        );
      } else {
        return withContentType({ encoding: 'json', json: parsed }, contentType);
      }
    } catch {
      // Falls through to the text branch, per step 2.
    }
  }

  if (text !== null && !text.includes('\u0000')) {
    return withContentType({ encoding: 'text', text }, contentType);
  }

  return withContentType({ encoding: 'base64', base64: encodeBase64(bytes) }, contentType);
}

function withContentType(body: Body, contentType?: string): Body {
  return contentType ? { ...body, contentType } : body;
}

/** Decode as UTF-8, returning null if the bytes are not valid UTF-8. */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** §6.5.1 step 2: `application/json`, or any subtype ending in `+json`. */
export function isJsonMediaType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(';')[0]!.trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

/** Structural validation of a body object, used when loading a fixture (§11.3). */
export function validateBody(body: unknown, at: string): Body {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HifStructuralError('Body must be an object', at);
  }
  const b = body as Record<string, unknown>;
  switch (b['encoding']) {
    case 'empty':
      return b as Body;
    case 'text':
      if (typeof b['text'] !== 'string') throw new HifStructuralError('Body with encoding "text" requires a string "text"', at);
      return b as Body;
    case 'json':
      if (!('json' in b)) throw new HifStructuralError('Body with encoding "json" requires a "json" member', at);
      return b as Body;
    case 'base64':
      if (typeof b['base64'] !== 'string') {
        throw new HifStructuralError('Body with encoding "base64" requires a string "base64"', at);
      }
      decodeBase64(b['base64'], at);
      return b as Body;
    case undefined:
      throw new HifStructuralError('Body requires an "encoding" member', at);
    default:
      throw new HifStructuralError(
        `Unknown body encoding ${JSON.stringify(b['encoding'])}; expected empty, text, json or base64`,
        at,
      );
  }
}
