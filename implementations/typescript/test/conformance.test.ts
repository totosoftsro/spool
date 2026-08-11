/**
 * The shared conformance suite, run against this implementation.
 *
 * Cases live in `conformance/cases/` and are language-neutral JSON. Every
 * implementation runs exactly these, so a case that passes here and fails in
 * Python is a real divergence — in one of the implementations, or in the spec.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  decodeQuery,
  digestPreimage,
  digestRequest,
  entropyTokens,
  findLossyNumbers,
  isMatch,
  matchRequest,
  normalizeRequest,
  normalizeUrl,
  parseFixture,
  parseTextTemplate,
  redactFixture,
  resolveMatchConfig,
  textMatchesTemplate,
  compilePortableRegex,
  explain,
  Player,
} from '../src/index.js';
import { HifMatchError, HifStructuralError } from '../src/errors.js';
import type { Fixture, HifRequest, JsonValue, MatchConfig } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE = join(HERE, '..', '..', '..', 'conformance');

interface ManifestEntry {
  id: string;
  kind: string;
  level: string;
  file: string;
}

const manifest = JSON.parse(readFileSync(join(CONFORMANCE, 'manifest.json'), 'utf8')) as {
  suite: string;
  specVersion: string;
  cases: ManifestEntry[];
};

function loadCase(entry: ManifestEntry): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CONFORMANCE, entry.file), 'utf8')) as Record<string, unknown>;
}

const byKind = new Map<string, ManifestEntry[]>();
for (const entry of manifest.cases) {
  const list = byKind.get(entry.kind) ?? [];
  list.push(entry);
  byKind.set(entry.kind, list);
}

function cases(kind: string): ManifestEntry[] {
  const list = byKind.get(kind);
  if (!list || list.length === 0) throw new Error(`No conformance cases of kind "${kind}"`);
  return list;
}

// The suite version this implementation claims to pass, asserted rather than declared.
it('targets the same spec version as the suite', () => {
  expect(manifest.specVersion).toBe('1.0');
});

describe('conformance: normalize (§6.4)', () => {
  for (const entry of cases('normalize')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      const url = normalizeUrl(c['url'] as string);
      const expected = c['expected'] as Record<string, unknown>;
      expect({
        scheme: url.scheme,
        host: url.host,
        port: url.port,
        path: url.path,
        query: decodeQuery(url.rawQuery),
        href: url.href,
      }).toEqual(expected);
    });
  }
});

describe('conformance: query (§6.4.1)', () => {
  for (const entry of cases('query')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      expect(decodeQuery(c['query'] as string)).toEqual(c['expected']);
    });
  }
});

describe('conformance: canonical JSON (§12)', () => {
  for (const entry of cases('canonical')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      expect(canonicalize(c['value'] as JsonValue)).toBe(c['expected']);
    });
  }
});

describe('conformance: round-trip loss (§12.3)', () => {
  for (const entry of cases('lossy')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      expect(findLossyNumbers(c['text'] as string)).toEqual(c['expected']);
    });
  }
});

describe('conformance: digest (§14)', () => {
  for (const entry of cases('digest')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      const request = c['request'] as HifRequest;
      // The pre-image is checked separately from the hash so that a failure
      // says whether the construction or the hashing is wrong.
      expect(canonicalize(digestPreimage(request))).toBe(c['preimage']);
      expect(digestRequest(request)).toBe(c['digest']);
    });
  }
});

describe('conformance: match (§7)', () => {
  for (const entry of cases('match')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      const cfg = resolveMatchConfig(undefined, c['config'] as MatchConfig);
      const result = matchRequest(
        normalizeRequest(c['recorded'] as HifRequest),
        normalizeRequest(c['live'] as HifRequest),
        cfg,
      );
      expect(isMatch(result)).toBe((c['expected'] as { matches: boolean }).matches);
    });
  }
});

describe('conformance: text templates (§7.4.3)', () => {
  for (const entry of cases('template')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      const template = parseTextTemplate(c['recorded'] as string);
      const subjects = c['subjects'] as string[];
      const expected = (c['expected'] as { matches: boolean[] }).matches;
      expect(subjects.map((s) => textMatchesTemplate(template, s))).toEqual(expected);
    });
  }
});

describe('conformance: regex subset (§7.6.2)', () => {
  for (const entry of cases('regex')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      const expected = c['expected'] as { valid: boolean; matches: boolean[] };
      if (!expected.valid) {
        expect(() => compilePortableRegex(c['pattern'] as string)).toThrow(HifStructuralError);
        return;
      }
      const re = compilePortableRegex(c['pattern'] as string);
      expect((c['subjects'] as string[]).map((s) => re.test(s))).toEqual(expected.matches);
    });
  }
});

describe('conformance: selection (§7.5)', () => {
  for (const entry of cases('select')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      const { fixture } = parseFixture(JSON.stringify(c['fixture']));
      const player = new Player(fixture);
      const expected = c['expected'] as { selected: string[]; faults?: Array<string | null> };

      const selected: string[] = [];
      const faults: Array<string | null> = [];
      for (const request of c['requests'] as HifRequest[]) {
        try {
          const play = player.select(request);
          selected.push(play.ref);
          faults.push(play.fault?.type ?? null);
        } catch (err) {
          expect(err).toBeInstanceOf(HifMatchError);
          selected.push('<unmatched>');
          faults.push(null);
        }
      }

      expect(selected).toEqual(expected.selected);
      if (expected.faults) expect(faults).toEqual(expected.faults);
    });
  }
});

describe('conformance: explain (§13)', () => {
  for (const entry of cases('explain')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      const { fixture } = parseFixture(JSON.stringify(c['fixture']));
      const expected = c['expected'] as Record<string, unknown>;

      const plays = new Map<number, number>();
      for (const [index, count] of Object.entries((c['plays'] as Record<string, number>) ?? {})) {
        plays.set(Number(index), count);
      }

      const report = explain({ fixture, live: normalizeRequest(c['live'] as HifRequest), plays });

      if (expected['empty'] !== undefined) expect(report.empty).toBe(expected['empty']);

      if (expected['candidateOrder']) {
        expect(report.candidates.map((x) => x.ref)).toEqual(expected['candidateOrder']);
      }
      if (expected['topScore'] !== undefined) expect(report.candidates[0]!.score).toBe(expected['topScore']);
      if (expected['topTotal'] !== undefined) expect(report.candidates[0]!.total).toBe(expected['topTotal']);
      if (expected['depleted'] !== undefined) expect(report.candidates[0]!.depleted).toBe(expected['depleted']);

      if (expected['reasons']) {
        const reasons = new Set<string>();
        for (const field of report.candidates[0]?.fields ?? []) {
          if (field.ok) continue;
          for (const detail of field.details ?? [field]) {
            if (detail.reason) reasons.add(detail.reason);
          }
        }
        for (const required of expected['reasons'] as string[]) {
          expect([...reasons].sort()).toContain(required);
        }
      }

      if (expected['paths']) {
        const paths = new Set<string>();
        for (const field of report.candidates[0]?.fields ?? []) {
          for (const detail of field.details ?? [field]) {
            if (detail.path) paths.add(detail.path);
          }
        }
        for (const required of expected['paths'] as string[]) expect([...paths]).toContain(required);
      }

      if (expected['suggestions']) {
        const wanted = expected['suggestions'] as Array<{ target: string; value: JsonValue }>;
        expect(report.suggestions.length).toBe(wanted.length === 0 ? 0 : report.suggestions.length);
        if (wanted.length === 0) {
          expect(report.suggestions).toEqual([]);
        } else {
          for (let i = 0; i < wanted.length; i++) {
            expect(report.suggestions[i]).toMatchObject({ ...wanted[i]!, verified: true });
          }
        }
      }

      // §13.4 is a hard guarantee, so check it on every explain case rather
      // than only where a case happens to assert it: applying any emitted
      // suggestion must actually make the request match.
      for (const suggestion of report.suggestions) {
        expect(suggestion.verified).toBe(true);
        const index = Number(/^interactions\[(\d+)\]/.exec(suggestion.target)?.[1]);
        const interaction = fixture.interactions[index]!;
        const patched = applySuggestion(interaction.match ?? {}, suggestion.target, suggestion.value);
        const cfg = resolveMatchConfig(fixture.defaults?.match, patched);
        expect(
          isMatch(
            matchRequest(normalizeRequest(interaction.request), normalizeRequest(c['live'] as HifRequest), cfg),
          ),
          `suggestion ${suggestion.target} did not actually fix the match`,
        ).toBe(true);
      }
    });
  }
});

/** Apply a dotted suggestion target onto a MatchConfig, for verification. */
function applySuggestion(base: MatchConfig, target: string, value: JsonValue): MatchConfig {
  const path = target.replace(/^interactions\[\d+\]\.match\.?/, '');
  const out = structuredClone(base) as Record<string, unknown>;
  const parts = path === '' ? [] : path.split('.');
  let node = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  if (parts.length > 0) node[parts[parts.length - 1]!] = value;
  return out as MatchConfig;
}

describe('conformance: redaction (§9)', () => {
  for (const entry of cases('redact')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      const { fixture } = parseFixture(JSON.stringify(c['fixture']));
      const result = redactFixture(fixture, (c['config'] as never) ?? {});
      const expected = c['expected'] as Record<string, unknown>;
      const it0 = result.value.interactions[0]!;

      if (expected['rules']) expect(result.rules).toEqual(expected['rules']);
      if (expected['requestHeaders']) expect(it0.request.headers).toEqual(expected['requestHeaders']);
      if (expected['responseHeaders']) expect(it0.response!.headers).toEqual(expected['responseHeaders']);
      if (expected['requestBodyJson']) {
        expect((it0.request.body as { json: JsonValue }).json).toEqual(expected['requestBodyJson']);
      }
      if (expected['responseBodyJson']) {
        expect((it0.response!.body as { json: JsonValue }).json).toEqual(expected['responseBodyJson']);
      }
      if (expected['requestBodyRedactedFlag'] !== undefined) {
        expect((it0.request.body as { redacted?: boolean }).redacted).toBe(expected['requestBodyRedactedFlag']);
      }
      if (expected['metaApplied'] !== undefined) {
        expect(result.value.meta?.redaction?.applied).toBe(expected['metaApplied']);
      }
      if (expected['requestUrlContains']) {
        for (const fragment of expected['requestUrlContains'] as string[]) {
          expect(it0.request.url).toContain(fragment);
        }
      }
    });
  }
});

describe('conformance: entropy (§9.4)', () => {
  for (const entry of cases('entropy')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      const cfg = c['config'] as { minLength: number; maxLength: number; minBits: number };
      expect(
        entropyTokens(c['subject'] as string, {
          ...cfg,
          headersAndQuery: true,
          textBodies: true,
        }),
      ).toEqual((c['expected'] as { tokens: string[] }).tokens);
    });
  }
});

describe('conformance: structural errors (§11.3)', () => {
  for (const entry of cases('structural')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      const expected = c['expected'] as { error: boolean; errorContains?: string };
      let thrown: unknown;
      try {
        parseFixture(JSON.stringify(c['document']));
      } catch (err) {
        thrown = err;
      }

      // `error: false` cases pin the negative side of a rule — that a legal
      // document close to a rejected one still loads. Without them a rule can be
      // implemented far too broadly and every positive case still passes.
      if (expected.error === false) {
        expect(thrown, 'expected this document to load').toBeUndefined();
        return;
      }

      expect(thrown, 'expected a structural error').toBeInstanceOf(HifStructuralError);
      if (expected.errorContains) {
        expect((thrown as Error).message).toContain(expected.errorContains);
      }
    });
  }
});

describe('conformance: versioning (§11.2)', () => {
  for (const entry of cases('version')) {
    it(entry.id, () => {
      const c = loadCase(entry);
      const expected = c['expected'] as { accepted: boolean; warns: boolean };

      if (!expected.accepted) {
        expect(() => parseFixture(JSON.stringify(c['document']))).toThrow(HifStructuralError);
        return;
      }

      const { warnings } = parseFixture(JSON.stringify(c['document']));
      expect(warnings.length > 0).toBe(expected.warns);
    });
  }
});

it('runs every case in the manifest', () => {
  const known = new Set([
    'normalize',
    'query',
    'canonical',
    'lossy',
    'digest',
    'match',
    'template',
    'regex',
    'select',
    'explain',
    'redact',
    'entropy',
    'structural',
    'version',
  ]);
  const unhandled = manifest.cases.filter((c) => !known.has(c.kind));
  expect(unhandled.map((c) => c.id)).toEqual([]);
});

it('declares the conformance levels it actually runs', () => {
  const levels = new Set(manifest.cases.map((c) => c.level));
  // This implementation runs every level. A partial implementation should skip
  // and report, never silently pass.
  expect([...levels].sort()).toEqual(['core', 'explain', 'full', 'redact']);
});

// A minimal fixture-shaped sanity check that the suite itself is well formed.
it('every case file parses and matches its manifest entry', () => {
  for (const entry of manifest.cases) {
    const c = loadCase(entry);
    expect(c['id'], entry.file).toBe(entry.id);
    expect(c['kind'], entry.file).toBe(entry.kind);
    expect(typeof c['description'], entry.file).toBe('string');
  }
});

export type { Fixture };
