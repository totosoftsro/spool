/**
 * JSON paths, per specification §7.7.
 *
 * RFC 6901 JSON Pointer, plus `*` as a single-token wildcard matching any member
 * name or array index. A literal `*` member name is written `~2`.
 */

import { HifStructuralError } from '../errors.js';
import type { JsonValue } from '../types.js';

export type PathToken = { kind: 'literal'; value: string } | { kind: 'wildcard' };

/** Parse a path into tokens. Throws a structural error on malformed input. */
export function parsePath(path: string): PathToken[] {
  if (path === '') {
    throw new HifStructuralError('JSON path must not be empty; the whole-document pointer is not valid here');
  }
  if (!path.startsWith('/')) {
    throw new HifStructuralError(`JSON path must start with "/": ${JSON.stringify(path)}`);
  }
  return path
    .slice(1)
    .split('/')
    .map((raw): PathToken => {
      if (raw === '*') return { kind: 'wildcard' };
      return { kind: 'literal', value: unescapeToken(raw, path) };
    });
}

function unescapeToken(token: string, path: string): string {
  let out = '';
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]!;
    if (ch !== '~') {
      out += ch;
      continue;
    }
    const next = token[i + 1];
    switch (next) {
      case '0':
        out += '~';
        break;
      case '1':
        out += '/';
        break;
      case '2':
        out += '*';
        break;
      default:
        throw new HifStructuralError(
          `Invalid escape "~${next ?? ''}" in JSON path ${JSON.stringify(path)}; only ~0, ~1 and ~2 are defined`,
        );
    }
    i++;
  }
  return out;
}

/**
 * Return every concrete location a path resolves to in `value`, as a list of
 * literal token sequences. A wildcard expands to one result per member or index
 * present, so a path that matches nothing returns an empty list — which §7.4.2
 * requires not to be an error.
 */
export function resolvePath(value: JsonValue, tokens: PathToken[]): string[][] {
  let frontier: Array<{ node: JsonValue; path: string[] }> = [{ node: value, path: [] }];

  for (const token of tokens) {
    const next: Array<{ node: JsonValue; path: string[] }> = [];
    for (const { node, path } of frontier) {
      if (Array.isArray(node)) {
        if (token.kind === 'wildcard') {
          node.forEach((child, i) => next.push({ node: child as JsonValue, path: [...path, String(i)] }));
        } else if (/^(0|[1-9][0-9]*)$/.test(token.value)) {
          const idx = Number(token.value);
          if (idx < node.length) next.push({ node: node[idx] as JsonValue, path: [...path, token.value] });
        }
      } else if (node !== null && typeof node === 'object') {
        const obj = node as Record<string, JsonValue>;
        if (token.kind === 'wildcard') {
          for (const k of Object.keys(obj)) next.push({ node: obj[k]!, path: [...path, k] });
        } else if (Object.prototype.hasOwnProperty.call(obj, token.value)) {
          next.push({ node: obj[token.value]!, path: [...path, token.value] });
        }
      }
    }
    frontier = next;
  }

  return frontier.map((f) => f.path);
}

/**
 * Return a deep copy of `value` with every location matched by `paths` removed.
 *
 * Removal, not replacement: §7.4.2 `json.ignore` must make a member invisible to
 * both the missing-member and unexpected-member checks, which only removal does.
 * Array elements are removed by index, highest first, so earlier indices stay
 * valid during the operation.
 */
export function omitPaths(value: JsonValue, paths: string[]): JsonValue {
  if (paths.length === 0) return value;
  const clone = structuredClone(value);
  const locations: string[][] = [];
  for (const p of paths) {
    locations.push(...resolvePath(clone, parsePath(p)));
  }
  // Deepest first, then highest index first, so that removals never invalidate a
  // location computed before them.
  locations.sort((a, b) => b.length - a.length || compareLast(b, a));
  for (const loc of locations) {
    removeAt(clone, loc);
  }
  return clone;
}

function compareLast(a: string[], b: string[]): number {
  const av = a[a.length - 1] ?? '';
  const bv = b[b.length - 1] ?? '';
  const an = Number(av);
  const bn = Number(bv);
  if (Number.isInteger(an) && Number.isInteger(bn)) return an - bn;
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function removeAt(root: JsonValue, location: string[]): void {
  if (location.length === 0) return;
  let node: JsonValue = root;
  for (let i = 0; i < location.length - 1; i++) {
    const key = location[i]!;
    if (Array.isArray(node)) node = node[Number(key)] as JsonValue;
    else if (node !== null && typeof node === 'object') node = (node as Record<string, JsonValue>)[key]!;
    else return;
  }
  const last = location[location.length - 1]!;
  if (Array.isArray(node)) {
    const idx = Number(last);
    if (Number.isInteger(idx) && idx >= 0 && idx < node.length) node.splice(idx, 1);
  } else if (node !== null && typeof node === 'object') {
    delete (node as Record<string, JsonValue>)[last];
  }
}

/**
 * Return a deep copy of `value` with every location matched by `paths` replaced
 * by `replacement`. Used by redaction (§9.3 `jsonPaths`), which keeps the member
 * so that the fixture shows a value was removed.
 */
export function replacePaths(value: JsonValue, paths: string[], replacement: JsonValue): { value: JsonValue; hits: number } {
  if (paths.length === 0) return { value, hits: 0 };
  const clone = structuredClone(value);
  const locations: string[][] = [];
  for (const p of paths) {
    locations.push(...resolvePath(clone, parsePath(p)));
  }
  for (const loc of locations) {
    setAt(clone, loc, replacement);
  }
  return { value: clone, hits: locations.length };
}

function setAt(root: JsonValue, location: string[], replacement: JsonValue): void {
  if (location.length === 0) return;
  let node: JsonValue = root;
  for (let i = 0; i < location.length - 1; i++) {
    const key = location[i]!;
    if (Array.isArray(node)) node = node[Number(key)] as JsonValue;
    else if (node !== null && typeof node === 'object') node = (node as Record<string, JsonValue>)[key]!;
    else return;
  }
  const last = location[location.length - 1]!;
  if (Array.isArray(node)) {
    const idx = Number(last);
    if (Number.isInteger(idx) && idx >= 0 && idx < node.length) node[idx] = replacement;
  } else if (node !== null && typeof node === 'object') {
    (node as Record<string, JsonValue>)[last] = replacement;
  }
}

/** Render a location as a §7.7 path string, for use in diagnostics. */
export function formatPath(location: string[]): string {
  return '/' + location.map((t) => t.replace(/~/g, '~0').replace(/\//g, '~1').replace(/\*/g, '~2')).join('/');
}
