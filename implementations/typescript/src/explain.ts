/**
 * The mismatch explanation engine, per specification §13.
 *
 * The design rule that matters, and the reason this file exists at all:
 *
 *   **A suggestion is never emitted unless it has been verified.**
 *
 * Verification is literal — apply the proposed configuration change, re-run the
 * matcher against the same live request, observe that it now matches. If nothing
 * verifies, the report says no single change explains the mismatch and offers
 * nothing. A wrong guess costs a developer more time than silence does, and
 * "request did not match" already wasted enough of it.
 */

import { interactionRef, playLimit, resolveMatchConfig } from './fixture.js';
import { isMatch, matchRequest, normalizeRequest } from './match.js';
import type {
  CandidateReport,
  FieldResult,
  Fixture,
  MismatchReport,
  NormalizedRequest,
  ResolvedMatchConfig,
  Suggestion,
} from './types.js';

export interface ExplainInput {
  fixture: Fixture;
  live: NormalizedRequest;
  /** Plays already consumed, by interaction index. */
  plays: Map<number, number>;
}

/** Build the mismatch report for a live request that matched nothing. */
export function explain({ fixture, live, plays }: ExplainInput): MismatchReport {
  const candidates: CandidateReport[] = fixture.interactions.map((interaction, index) => {
    const cfg = resolveMatchConfig(fixture.defaults?.match, interaction.match);
    const recorded = normalizeRequest(interaction.request);
    const fields = matchRequest(recorded, live, cfg);
    const score = fields.filter((f) => f.ok).length;

    const limit = playLimit(fixture, interaction);
    const used = plays.get(index) ?? 0;
    const exhausted = limit !== 'unlimited' && used >= limit;

    // §13.3: a depleted candidate that would otherwise have matched is the
    // actual cause of the failure. Reporting it as an ordinary mismatch hides
    // "you called this three times but recorded it twice".
    const depleted = exhausted && isMatch(fields);
    const withDepleted: FieldResult[] = depleted
      ? [...fields, { field: 'replay', ok: false, reason: 'depleted', expected: limit, actual: used }]
      : fields;

    return {
      ref: interactionRef(interaction, index),
      index,
      score,
      total: fields.length,
      depleted,
      fields: withDepleted,
    };
  });

  // §13.2: score desc, then total desc, then index asc. A total order, so the
  // report never depends on iteration order.
  candidates.sort((a, b) => b.score - a.score || b.total - a.total || a.index - b.index);

  const suggestions = candidates.length > 0 ? suggestFor(fixture, candidates[0]!, live) : [];

  return { request: live, candidates, suggestions, empty: fixture.interactions.length === 0 };
}

interface ProposedChange {
  target: string;
  value: unknown;
  description: string;
  apply(cfg: ResolvedMatchConfig): ResolvedMatchConfig;
}

/**
 * §13.4: propose changes in the specified order, verify each, keep the first
 * three that work.
 *
 * The ordering is normative so that two implementations produce the same
 * suggestions for the same failure. It runs cheapest-and-most-targeted first:
 * allowing extra JSON members before ignoring a whole field, and ignoring a
 * whole field before ignoring the entire body.
 */
function suggestFor(fixture: Fixture, candidate: CandidateReport, live: NormalizedRequest): Suggestion[] {
  const interaction = fixture.interactions[candidate.index];
  if (!interaction) return [];

  // A depleted candidate has no configuration fix; the fixture needs another
  // recording or a higher play count. Saying nothing is correct here.
  if (candidate.depleted) return [];

  const baseCfg = resolveMatchConfig(fixture.defaults?.match, interaction.match);
  const recorded = normalizeRequest(interaction.request);
  const prefix = `interactions[${candidate.index}].match`;

  const proposals: ProposedChange[] = [];

  // 1. Allow unexpected JSON members.
  if (baseCfg.body.json.extra === 'reject') {
    proposals.push({
      target: `${prefix}.body.json.extra`,
      value: 'allow',
      description: 'Allow unexpected members in the request body',
      apply: (c) => ({ ...c, body: { ...c.body, json: { ...c.body.json, extra: 'allow' } } }),
    });
  }

  // 2. Ignore each differing JSON path.
  for (const path of differingJsonPaths(candidate.fields)) {
    proposals.push({
      target: `${prefix}.body.json.ignore`,
      value: [...baseCfg.body.json.ignore, path],
      description: `Ignore the request-body field ${path}`,
      apply: (c) => ({ ...c, body: { ...c.body, json: { ...c.body.json, ignore: [...c.body.json.ignore, path] } } }),
    });
  }

  // 3. Ignore each differing query parameter.
  for (const name of differingNames(candidate.fields, 'query')) {
    proposals.push({
      target: `${prefix}.query.ignore`,
      value: [...baseCfg.query.ignore, name],
      description: `Ignore the query parameter "${name}"`,
      apply: (c) => ({ ...c, query: { ...c.query, ignore: [...c.query.ignore, name] } }),
    });
  }

  // 4. Ignore each differing header.
  for (const name of differingNames(candidate.fields, 'headers')) {
    proposals.push({
      target: `${prefix}.headers.ignore`,
      value: [...baseCfg.headers.ignore, name],
      description: `Ignore the "${name}" header`,
      apply: (c) => ({ ...c, headers: { ...c.headers, ignore: [...c.headers.ignore, name] } }),
    });
  }

  // 5. Ignore each scalar field, in the order the spec lists.
  for (const field of ['method', 'scheme', 'host', 'port', 'path'] as const) {
    if (baseCfg[field] !== 'exact') continue;
    proposals.push({
      target: `${prefix}.${field}`,
      value: 'ignore',
      description: `Stop comparing the request ${field}`,
      apply: (c) => ({ ...c, [field]: 'ignore' }),
    });
  }

  // 6. Ignore the body entirely.
  if (baseCfg.body.mode !== 'ignore') {
    proposals.push({
      target: `${prefix}.body.mode`,
      value: 'ignore',
      description: 'Stop comparing the request body',
      apply: (c) => ({ ...c, body: { ...c.body, mode: 'ignore' } }),
    });
  }

  const verified: Suggestion[] = [];
  for (const proposal of proposals) {
    if (verified.length === 3) break;
    let candidateCfg: ResolvedMatchConfig;
    try {
      candidateCfg = proposal.apply(structuredClone(baseCfg));
    } catch {
      continue;
    }
    let nowMatches: boolean;
    try {
      nowMatches = isMatch(matchRequest(recorded, live, candidateCfg));
    } catch {
      // A proposal that makes matching throw is not a fix.
      continue;
    }
    if (!nowMatches) continue;
    verified.push({
      kind: 'match-config',
      target: proposal.target,
      value: proposal.value as Suggestion['value'],
      description: proposal.description,
      verified: true,
    });
  }

  return verified;
}

/** Distinct JSON paths that differed, in first-reported order. */
function differingJsonPaths(fields: FieldResult[]): string[] {
  const paths: string[] = [];
  for (const field of fields) {
    if (field.field !== 'body' || field.ok) continue;
    for (const detail of field.details ?? [field]) {
      if (detail.path && detail.reason?.startsWith('json.') && !paths.includes(detail.path)) {
        paths.push(detail.path);
      }
    }
  }
  return paths;
}

/** Distinct query parameter or header names that differed, in first-reported order. */
function differingNames(fields: FieldResult[], which: 'query' | 'headers'): string[] {
  const names: string[] = [];
  for (const field of fields) {
    if (field.field !== which || field.ok) continue;
    for (const detail of field.details ?? [field]) {
      if (detail.path && !names.includes(detail.path)) names.push(detail.path);
    }
  }
  return names;
}
