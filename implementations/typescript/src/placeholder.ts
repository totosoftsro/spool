/**
 * Placeholders, per specification §7.6.
 *
 * A placeholder marks a position whose value is not fixed. The rule that makes
 * this safe is narrow recognition: outside a text-body template, a string is a
 * placeholder only if the *entire* string is `{{…}}` and names a defined
 * placeholder. A body that legitimately contains `{{any}}` in the middle of a
 * sentence is unaffected.
 */

import { compilePortableRegex } from './regex.js';
import type { JsonValue } from './types.js';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO8601 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const JSON_NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

export type Placeholder =
  | { kind: 'any' }
  | { kind: 'type'; type: 'string' | 'number' | 'boolean' | 'array' | 'object' }
  | { kind: 'uuid' }
  | { kind: 'iso8601' }
  | { kind: 'regex'; pattern: string }
  | { kind: 'redacted' };

/**
 * Recognise a whole-string placeholder.
 *
 * Returns null for anything that is not one, including a string that merely
 * contains `{{…}}` and a string escaped per §7.6.1.
 */
export function parsePlaceholder(s: string): Placeholder | null {
  if (!s.startsWith('{{') || !s.endsWith('}}') || s.length < 5) return null;
  const inner = s.slice(2, -2);
  if (inner.includes('}}')) return null;

  if (inner === 'any') return { kind: 'any' };
  if (inner === 'redacted') return { kind: 'redacted' };
  if (inner === 'any:string') return { kind: 'type', type: 'string' };
  if (inner === 'any:number') return { kind: 'type', type: 'number' };
  if (inner === 'any:boolean') return { kind: 'type', type: 'boolean' };
  if (inner === 'any:array') return { kind: 'type', type: 'array' };
  if (inner === 'any:object') return { kind: 'type', type: 'object' };
  if (inner === 'any:uuid') return { kind: 'uuid' };
  if (inner === 'any:iso8601') return { kind: 'iso8601' };
  if (inner.startsWith('regex:')) return { kind: 'regex', pattern: inner.slice('regex:'.length) };
  return null;
}

/** True when a recorded string is a placeholder rather than a literal. */
export function isPlaceholder(s: string): boolean {
  return parsePlaceholder(s) !== null;
}

/**
 * §7.6.1: `\{{…}}` at position 0 denotes the literal text `{{…}}`.
 *
 * Applied to a recorded string before literal comparison. The escape is
 * recognised only at position 0 and only before `{{`, so a backslash anywhere
 * else stays an ordinary character.
 */
export function unescapeLiteral(s: string): string {
  return s.startsWith('\\{{') ? s.slice(1) : s;
}

/** Does a JSON value satisfy a placeholder? Used for `json` body matching (§7.4.2). */
export function satisfiesJson(placeholder: Placeholder, actual: JsonValue): boolean {
  switch (placeholder.kind) {
    case 'any':
    case 'redacted':
      return true;
    case 'type':
      switch (placeholder.type) {
        case 'string':
          return typeof actual === 'string';
        case 'number':
          return typeof actual === 'number';
        case 'boolean':
          return typeof actual === 'boolean';
        case 'array':
          return Array.isArray(actual);
        case 'object':
          return actual !== null && typeof actual === 'object' && !Array.isArray(actual);
      }
      return false;
    case 'uuid':
      return typeof actual === 'string' && UUID.test(actual);
    case 'iso8601':
      return typeof actual === 'string' && ISO8601.test(actual);
    case 'regex':
      return typeof actual === 'string' && compilePortableRegex(placeholder.pattern).test(actual);
  }
}

/**
 * Does a string satisfy a placeholder?
 *
 * Used for header values, query values and text bodies, where every value is a
 * string. §7.6: `{{any}}` matches any string here, and `{{any:number}}` matches
 * a string whose content is a JSON number literal.
 */
export function satisfiesString(placeholder: Placeholder, actual: string): boolean {
  switch (placeholder.kind) {
    case 'any':
    case 'redacted':
    case 'type':
      if (placeholder.kind === 'type') {
        switch (placeholder.type) {
          case 'string':
            return true;
          case 'number':
            return JSON_NUMBER.test(actual);
          case 'boolean':
            return actual === 'true' || actual === 'false';
          case 'array':
          case 'object':
            return false;
        }
      }
      return true;
    case 'uuid':
      return UUID.test(actual);
    case 'iso8601':
      return ISO8601.test(actual);
    case 'regex':
      return compilePortableRegex(placeholder.pattern).test(actual);
  }
}

/**
 * Compare a recorded string against a live string, honouring a whole-string
 * placeholder and the §7.6.1 escape.
 */
export function stringMatches(recorded: string, actual: string): boolean {
  const ph = parsePlaceholder(recorded);
  if (ph) return satisfiesString(ph, actual);
  return unescapeLiteral(recorded) === actual;
}

// ---------------------------------------------------------------------------
// Text body templates (§7.4.3)
// ---------------------------------------------------------------------------

const PLACEHOLDER_ANYWHERE = /\{\{(any(?::[a-z0-9]+)?|redacted|regex:(?:[^}]|\}(?!\}))*)\}\}/g;

export interface TextTemplate {
  /** Literal segments, in order. `segments.length === placeholders.length + 1`. */
  segments: string[];
  placeholders: Placeholder[];
}

/** Split a recorded text body into literal segments and the placeholders between them. */
export function parseTextTemplate(recorded: string): TextTemplate {
  const segments: string[] = [];
  const placeholders: Placeholder[] = [];
  let last = 0;

  PLACEHOLDER_ANYWHERE.lastIndex = 0;
  for (const m of recorded.matchAll(PLACEHOLDER_ANYWHERE)) {
    const ph = parsePlaceholder(m[0]);
    if (!ph) continue;
    segments.push(recorded.slice(last, m.index));
    placeholders.push(ph);
    last = m.index + m[0].length;
  }
  segments.push(recorded.slice(last));
  return { segments, placeholders };
}

/**
 * §7.4.3 template matching: anchored at both ends, leftmost-shortest for each
 * gap, single left-to-right scan with no backtracking.
 *
 * The no-backtracking rule is what makes this deterministic and linear. It also
 * means the gap contents are whatever falls between the located literals, which
 * is then checked against the placeholder's own constraint — so
 * `{{any:number}}` inside a text body still has to be a number.
 */
export function textMatchesTemplate(template: TextTemplate, actual: string): boolean {
  const { segments, placeholders } = template;
  if (placeholders.length === 0) return segments[0] === actual;

  const first = segments[0]!;
  if (!actual.startsWith(first)) return false;
  let cursor = first.length;

  for (let i = 0; i < placeholders.length; i++) {
    const nextLiteral = segments[i + 1]!;
    const isLast = i === placeholders.length - 1;

    let gapEnd: number;
    if (isLast) {
      if (!actual.endsWith(nextLiteral)) return false;
      gapEnd = actual.length - nextLiteral.length;
      if (gapEnd < cursor) return false;
    } else if (nextLiteral === '') {
      // Two adjacent placeholders: the gap is empty by the leftmost-shortest
      // rule, since the next literal is found immediately.
      gapEnd = cursor;
    } else {
      const found = actual.indexOf(nextLiteral, cursor);
      if (found === -1) return false;
      gapEnd = found;
    }

    if (!satisfiesString(placeholders[i]!, actual.slice(cursor, gapEnd))) return false;
    cursor = gapEnd + nextLiteral.length;
  }

  return cursor === actual.length;
}
