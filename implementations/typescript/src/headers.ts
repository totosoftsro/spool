/**
 * Header handling, per specification §6.3 and §6.6.
 *
 * Headers are an ordered list of pairs, not a map, because HTTP permits repeated
 * field names and JSON objects cannot express them. Collapsing `set-cookie` into
 * one entry is a real bug in several existing tools.
 */

import { HifStructuralError } from './errors.js';
import { decodeBase64, decodeUtf8Strict, encodeBase64 } from './body.js';
import type { HeaderEntry } from './types.js';

export interface NormalizedHeader {
  /** Lowercased field name. */
  name: string;
  /** OWS-stripped field value. For a binary value, the U+FFFD-lossy decoding. */
  value: string;
  /** True when the stored entry used the three-element non-UTF-8 form (§6.6). */
  binary: boolean;
  /** Raw bytes, present only for binary values. */
  bytes?: Uint8Array;
}

/** RFC 9110 optional whitespace: SP and HTAB only. */
export function stripOws(value: string): string {
  return value.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

export function normalizeHeaders(entries: HeaderEntry[] | undefined): NormalizedHeader[] {
  if (!entries) return [];
  return entries.map((entry, i) => normalizeEntry(entry, `headers[${i}]`));
}

function normalizeEntry(entry: HeaderEntry, at: string): NormalizedHeader {
  if (!Array.isArray(entry) || entry.length < 2) {
    throw new HifStructuralError('Header entry must be [name, value] or [name, null, base64]', at);
  }
  const [name, second, third] = entry as [unknown, unknown, unknown];
  if (typeof name !== 'string') throw new HifStructuralError('Header name must be a string', at);

  if (second === null) {
    if (typeof third !== 'string') {
      throw new HifStructuralError('A three-element header entry requires a base64 string as its third element', at);
    }
    const bytes = decodeBase64(third, at);
    return {
      name: name.toLowerCase(),
      value: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
      binary: true,
      bytes,
    };
  }

  if (typeof second !== 'string') throw new HifStructuralError('Header value must be a string or null', at);
  return { name: name.toLowerCase(), value: stripOws(second), binary: false };
}

/** Build storable entries from live header data, choosing the §6.6 form when needed. */
export function toEntries(headers: Iterable<[string, string]>): HeaderEntry[] {
  const out: HeaderEntry[] = [];
  for (const [name, value] of headers) {
    out.push([name.toLowerCase(), stripOws(value)]);
  }
  return out;
}

/** Build a storable entry from raw bytes, using the §6.6 form when they are not UTF-8. */
export function toEntryFromBytes(name: string, valueBytes: Uint8Array): HeaderEntry {
  const text = decodeUtf8Strict(valueBytes);
  if (text === null) return [name.toLowerCase(), null, encodeBase64(valueBytes)];
  return [name.toLowerCase(), stripOws(text)];
}

/** All values for a field name, in order. §7.2 compares these lists. */
export function valuesFor(headers: NormalizedHeader[], name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter((h) => h.name === lower).map((h) => h.value);
}

/** The distinct field names present, in first-appearance order. */
export function namesOf(headers: NormalizedHeader[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of headers) {
    if (!seen.has(h.name)) {
      seen.add(h.name);
      out.push(h.name);
    }
  }
  return out;
}

/** Case-insensitive membership, for `include` and `ignore` lists. */
export function containsName(list: string[], name: string): boolean {
  const lower = name.toLowerCase();
  return list.some((n) => n.toLowerCase() === lower);
}
