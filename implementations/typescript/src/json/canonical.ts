/**
 * RFC 8785 (JSON Canonicalization Scheme), per specification §12.
 *
 * JavaScript is the easy case: RFC 8785 defines number serialization as
 * ECMAScript `Number::toString` and string escaping as ECMAScript
 * `QuoteJSONString`, both of which `JSON.stringify` already implements. What is
 * left is member ordering, which JSON.stringify does not do.
 */

import type { JsonValue } from '../types.js';

/**
 * Serialize a JSON value to its RFC 8785 canonical form.
 *
 * @throws TypeError if the value contains a non-finite number, `undefined`, or a
 * non-plain object — none of which are JSON, and all of which would otherwise be
 * silently coerced by JSON.stringify.
 */
export function canonicalize(value: JsonValue): string {
  const out: string[] = [];
  write(value, out, []);
  return out.join('');
}

function write(value: JsonValue, out: string[], path: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`Non-finite number at /${path.join('/')} is not valid JSON`);
      }
      // §12.3: ECMAScript Number::toString. JSON.stringify applies exactly this,
      // including -0 serializing as 0.
      out.push(JSON.stringify(value));
      return;
    case 'string':
      // §12.2: ECMAScript QuoteJSONString — short escapes where defined,
      // \u00xx with lowercase hex otherwise.
      out.push(JSON.stringify(value));
      return;
    default:
      break;
  }

  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(',');
      const el = value[i];
      if (el === undefined) {
        throw new TypeError(`Sparse array hole at /${path.join('/')}/${i} is not valid JSON`);
      }
      write(el, out, [...path, String(i)]);
    }
    out.push(']');
    return;
  }

  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`Value at /${path.join('/')} is not a plain JSON object`);
    }
    const obj = value as Record<string, JsonValue>;
    // §12.1: members sorted by the UTF-16 code unit sequence of their names,
    // which is exactly the default ordering of Array.prototype.sort on strings.
    const keys = Object.keys(obj).sort();
    out.push('{');
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (i > 0) out.push(',');
      out.push(JSON.stringify(k), ':');
      const v = obj[k];
      if (v === undefined) {
        throw new TypeError(`Member "${k}" at /${path.join('/')} is undefined, which is not JSON`);
      }
      write(v, out, [...path, k]);
    }
    out.push('}');
    return;
  }

  throw new TypeError(`Value of type ${typeof value} at /${path.join('/')} is not JSON`);
}

/** Structural equality under canonical form. Cheaper than it looks for small bodies. */
export function canonicalEqual(a: JsonValue, b: JsonValue): boolean {
  return canonicalize(a) === canonicalize(b);
}

const NUMBER_LITERAL = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;

export interface LossyNumber {
  literal: string;
  canonical: string;
}

/**
 * §12.3 round-trip loss detection.
 *
 * Finds numeric literals in raw JSON text whose value changes when parsed as an
 * IEEE 754 double and re-serialized — the case that silently corrupts 64-bit
 * integer IDs. Recorders warn on this and prefer a `text` body instead.
 *
 * This scans the raw text rather than the parsed value because the parsed value
 * has already lost the information. String contents are skipped, so a literal
 * inside `"id": "10000000000000001"` is correctly ignored.
 */
export function findLossyNumbers(rawJson: string): LossyNumber[] {
  const found: LossyNumber[] = [];
  const seen = new Set<string>();
  for (const segment of outsideStrings(rawJson)) {
    for (const m of segment.matchAll(NUMBER_LITERAL)) {
      const literal = m[0];
      if (seen.has(literal)) continue;
      seen.add(literal);
      const canonical = JSON.stringify(Number(literal));
      if (exactDecimal(literal) !== exactDecimal(canonical)) {
        found.push({ literal, canonical });
      }
    }
  }
  return found;
}

/**
 * The exact mathematical value of a decimal literal, as a comparable key.
 *
 * A literal differing from its canonical form is not automatically lossy: `1.0`
 * canonicalizes to `1`, and `1e2` to `100`, with no loss of value. Loss means the
 * exact decimal written in the document is not the exact decimal the double
 * represents — which is what this compares.
 */
function exactDecimal(literal: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (!m) return literal;
  const sign = m[1] === '-' ? '-' : '';
  const intPart = m[2]!;
  const fracPart = m[3] ?? '';
  const exp = m[4] ? parseInt(m[4], 10) : 0;

  // Combine into digits × 10^scale, then strip leading and trailing zeros so
  // that 1, 1.0, 0.1e1 and 100e-2 all reduce to the same key.
  let digits = intPart + fracPart;
  let scale = exp - fracPart.length;
  const firstSignificant = digits.search(/[1-9]/);
  if (firstSignificant === -1) return '0';
  digits = digits.slice(firstSignificant);
  const trailing = digits.length - digits.replace(/0+$/, '').length;
  digits = digits.slice(0, digits.length - trailing);
  scale += trailing;
  return `${sign}${digits}e${scale}`;
}

/** Yields the parts of a JSON document that are outside string literals. */
function* outsideStrings(text: string): Generator<string> {
  let i = 0;
  let start = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      yield text.slice(start, i);
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      start = i;
    } else {
      i++;
    }
  }
  yield text.slice(start);
}
