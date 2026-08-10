/**
 * Human-readable rendering of a mismatch report (§13).
 *
 * The report data structure is normative; this rendering is not. It is, however,
 * the thing a developer actually reads at 2am, so it gets the same care.
 *
 * Rules followed here:
 *  - Show what matched, not just what failed. "✓ method ✓ path ✗ body" locates
 *    the problem far faster than the failure alone.
 *  - Never imply a cause that has not been proven. Suggestions come from the
 *    verified list or are absent.
 *  - Deterministic output. No timestamps, no durations, no set iteration.
 */

import type { CandidateReport, FieldResult, JsonValue, MismatchReport, NormalizedRequest } from './types.js';

export interface RenderOptions {
  /** Show every candidate rather than only the closest. */
  all?: boolean;
  /** ANSI colour. Defaults to off, which is what CI logs want. */
  color?: boolean;
  /** Truncate rendered values to this many characters. */
  maxValueLength?: number;
}

const TICK = '✓';
const CROSS = '✗';

export function renderMismatch(report: MismatchReport, options: RenderOptions = {}): string {
  const { all = false, color = false, maxValueLength = 400 } = options;
  const c = colorizer(color);
  const lines: string[] = [];

  lines.push(c.bold('REQUEST MISMATCH'));
  lines.push('');
  lines.push(`  ${report.request.method} ${report.request.url}`);
  lines.push('');

  if (report.empty) {
    lines.push('  The fixture contains no interactions, so nothing could match.');
    lines.push('  Record it first, or point the player at a different fixture.');
    return lines.join('\n') + '\n';
  }

  const shown = all ? report.candidates : report.candidates.slice(0, 1);

  for (const candidate of shown) {
    lines.push(...renderCandidate(candidate, c, maxValueLength));
    lines.push('');
  }

  const hidden = report.candidates.length - shown.length;
  if (hidden > 0) {
    lines.push(
      `  ${hidden} other candidate${hidden === 1 ? '' : 's'} checked. ` +
        'Set SPOOL_EXPLAIN=all to see them.',
    );
    lines.push('');
  }

  if (report.suggestions.length > 0) {
    lines.push(c.bold('  Suggested action'));
    for (const s of report.suggestions) {
      lines.push(`    ${s.description}:`);
      lines.push(c.dim(`      ${s.target} = ${JSON.stringify(s.value)}`));
    }
    lines.push('');
    lines.push(c.dim('  Each suggestion was verified: applying it makes this request match.'));
  } else if (!report.candidates[0]?.depleted) {
    // §13.4: silence beats speculation.
    lines.push('  No single configuration change makes the closest candidate match,');
    lines.push('  so no fix is suggested. Re-record the fixture, or compare the');
    lines.push('  differences above by hand.');
  }

  return lines.join('\n') + '\n';
}

function renderCandidate(candidate: CandidateReport, c: Colorizer, maxLen: number): string[] {
  const lines: string[] = [];
  lines.push(
    `  ${c.bold('Closest candidate')}: ${candidate.ref}  ${c.dim(`(${candidate.score}/${candidate.total} fields matched)`)}`,
  );
  lines.push('');

  for (const field of candidate.fields) {
    if (field.ok) {
      lines.push(`    ${c.green(TICK)} ${pad(field.field)} ${c.dim(okValue(field))}`.trimEnd());
      continue;
    }
    if (field.reason === 'depleted') {
      lines.push(`    ${c.red(CROSS)} ${pad('replay')} already played ${String(field.actual)} of ${String(field.expected)} times`);
      lines.push('');
      lines.push('      This interaction matches the request in every compared field,');
      lines.push('      but its play count is exhausted. Either the code under test');
      lines.push('      makes more calls than were recorded, or the fixture needs');
      lines.push(`      "replay": { "times": ${Number(field.actual) + 1} } or "unlimited".`);
      continue;
    }
    lines.push(`    ${c.red(CROSS)} ${pad(field.field)} ${c.dim(field.reason ?? '')}`);
    for (const detail of field.details ?? [field]) {
      lines.push(...renderDetail(detail, c, maxLen));
    }
  }

  return lines;
}

function renderDetail(detail: FieldResult, c: Colorizer, maxLen: number): string[] {
  const lines: string[] = [];
  const where = detail.path ? `      at ${detail.path}` : '     ';

  switch (detail.reason) {
    case 'json.unexpected-member':
    case 'query.unexpected-param':
    case 'header.unexpected':
      lines.push(`${where}`);
      lines.push(`        ${c.dim('expected')}  (absent)`);
      lines.push(`        ${c.dim('received')}  ${short(detail.actual, maxLen)}`);
      lines.push(`        ${c.yellow('unexpected')}`);
      return lines;

    case 'json.missing-member':
    case 'query.missing-param':
    case 'header.missing':
      lines.push(`${where}`);
      lines.push(`        ${c.dim('expected')}  ${short(detail.expected, maxLen)}`);
      lines.push(`        ${c.dim('received')}  (absent)`);
      lines.push(`        ${c.yellow('missing')}`);
      return lines;

    case 'json.placeholder-unsatisfied':
      lines.push(`${where}`);
      lines.push(`        ${c.dim('placeholder')}  ${short(detail.expected, maxLen)}`);
      lines.push(`        ${c.dim('received')}     ${short(detail.actual, maxLen)}`);
      lines.push(`        ${c.yellow('the received value does not satisfy the placeholder')}`);
      return lines;

    case 'body.not-json':
      lines.push('        the body was expected to be JSON but did not parse');
      return lines;

    case 'body.not-text':
      lines.push('        the body is binary and cannot be compared as text');
      return lines;

    default:
      lines.push(`${where}`);
      lines.push(`        ${c.dim('expected')}  ${short(detail.expected, maxLen)}`);
      lines.push(`        ${c.dim('received')}  ${short(detail.actual, maxLen)}`);
      return lines;
  }
}

/**
 * What to show beside a field that matched.
 *
 * A compared-and-equal composite field (query, headers, body) has no single
 * value worth printing, so it prints nothing rather than "(absent)", which
 * would read as a failure. A null port means the scheme default applied.
 */
function okValue(field: FieldResult): string {
  if (field.field === 'port' && field.actual === null) return '(scheme default)';
  if (field.actual === undefined) return '';
  return short(field.actual, 80);
}

function pad(field: string): string {
  return (field + ':').padEnd(9);
}

function short(value: JsonValue | undefined, maxLen: number): string {
  if (value === undefined) return '(absent)';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '(absent)';
  return text.length > maxLen ? text.slice(0, maxLen) + `… (${text.length} chars)` : text;
}

/** Render a normalized request compactly, for `spool explain` and debug output. */
export function renderRequest(req: NormalizedRequest): string {
  const lines = [`${req.method} ${req.url}`];
  for (const h of req.headers) lines.push(`  ${h.name}: ${h.value}`);
  if (req.body.encoding !== 'empty') {
    lines.push('');
    lines.push(`  ${bodySummary(req)}`);
  }
  return lines.join('\n');
}

function bodySummary(req: NormalizedRequest): string {
  const b = req.body;
  switch (b.encoding) {
    case 'empty':
      return '(no body)';
    case 'text':
      return b.text.length > 500 ? b.text.slice(0, 500) + '…' : b.text;
    case 'json':
      return JSON.stringify(b.json, null, 2).split('\n').join('\n  ');
    case 'base64':
      return `(binary, ${Math.floor((b.base64.length * 3) / 4)} bytes)`;
  }
}

interface Colorizer {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
}

function colorizer(enabled: boolean): Colorizer {
  if (!enabled) {
    const id = (s: string): string => s;
    return { bold: id, dim: id, red: id, green: id, yellow: id };
  }
  const wrap = (code: string) => (s: string) => `\u001b[${code}m${s}\u001b[0m`;
  return { bold: wrap('1'), dim: wrap('2'), red: wrap('31'), green: wrap('32'), yellow: wrap('33') };
}
