/**
 * The player: selection, replay, faults and expectations.
 *
 * Implements §7.5 (selection), §8.1 (header handling on delivery), §10 (faults)
 * and §5.4 (expectations).
 *
 * The player is the only stateful part of the system. Fixtures are immutable
 * during replay; play counts live here, and are reset when a player is
 * constructed or reset, so tests stay isolated (§7.5).
 */

import { bodyBytes } from './body.js';
import { HifExpectationError, HifFaultError, HifMatchError } from './errors.js';
import { explain } from './explain.js';
import { interactionRef, playLimit, resolveMatchConfig } from './fixture.js';
import { isMatch, matchRequest, normalizeRequest } from './match.js';
import { renderMismatch } from './render.js';
import type { Fault, Fixture, HifRequest, HifResponse, Interaction, MismatchReport, NormalizedRequest } from './types.js';

export interface PlayerOptions {
  /**
   * Sleep for `timing.latencyMs` before delivering a response.
   *
   * §5.3: off by default. Sleeping by default would slow every test suite for
   * no correctness benefit.
   */
  simulateLatency?: boolean;
  /** Multiplier applied to simulated latency. 0.1 makes a 2s recording take 200ms. */
  latencyScale?: number;
  /** Show every candidate in mismatch reports rather than only the closest. */
  explainAll?: boolean;
  /** ANSI colour in rendered reports. */
  color?: boolean;
}

export interface Play {
  interaction: Interaction;
  index: number;
  ref: string;
  response?: HifResponse;
  fault?: Fault;
  /** Milliseconds the player would sleep, before `latencyScale`. */
  latencyMs: number;
}

export class Player {
  readonly fixture: Fixture;
  private readonly options: PlayerOptions;
  private plays = new Map<number, number>();

  constructor(fixture: Fixture, options: PlayerOptions = {}) {
    this.fixture = fixture;
    this.options = options;
  }

  /** §7.5: reset play counts. Call between tests to restore isolation. */
  reset(): void {
    this.plays = new Map();
  }

  /** How many times an interaction has been played so far. */
  playCount(index: number): number {
    return this.plays.get(index) ?? 0;
  }

  /**
   * §7.5 selection.
   *
   * Returns the chosen interaction and consumes one play, or throws
   * `HifMatchError` carrying the §13 report. The player never performs a live
   * request; falling through to the network is a caller decision, made by
   * catching this error.
   */
  select(request: HifRequest): Play {
    const live = normalizeRequest(request);
    const chosen = this.find(live);

    if (chosen === null) {
      const report = explain({ fixture: this.fixture, live, plays: this.plays });
      throw new HifMatchError(
        renderMismatch(report, { all: this.explainAll(), color: this.options.color ?? false }),
        report,
      );
    }

    const { interaction, index } = chosen;
    this.plays.set(index, (this.plays.get(index) ?? 0) + 1);

    const play: Play = {
      interaction,
      index,
      ref: interactionRef(interaction, index),
      latencyMs: interaction.timing?.latencyMs ?? 0,
    };
    if (interaction.response) play.response = interaction.response;
    if (interaction.fault) play.fault = interaction.fault;
    return play;
  }

  /** Build the §13 report for a request without consuming a play. */
  explainRequest(request: HifRequest): MismatchReport {
    return explain({ fixture: this.fixture, live: normalizeRequest(request), plays: this.plays });
  }

  /** True when the request would match, without consuming a play. */
  wouldMatch(request: HifRequest): boolean {
    return this.find(normalizeRequest(request)) !== null;
  }

  private find(live: NormalizedRequest): { interaction: Interaction; index: number } | null {
    // §7.5 steps 1-3: first match in document order among interactions with
    // plays remaining.
    for (let index = 0; index < this.fixture.interactions.length; index++) {
      const interaction = this.fixture.interactions[index]!;
      const limit = playLimit(this.fixture, interaction);
      if (limit !== 'unlimited' && (this.plays.get(index) ?? 0) >= limit) continue;

      const cfg = resolveMatchConfig(this.fixture.defaults?.match, interaction.match);
      const recorded = normalizeRequest(interaction.request);
      if (isMatch(matchRequest(recorded, live, cfg))) return { interaction, index };
    }
    return null;
  }

  /** Sleep for the play's latency, if latency simulation is enabled (§5.3, §10). */
  async delay(play: Play): Promise<void> {
    if (!this.options.simulateLatency) return;
    const extra = play.fault?.afterMs ?? 0;
    const total = (play.latencyMs + extra) * (this.options.latencyScale ?? 1);
    if (total > 0) await new Promise((resolve) => setTimeout(resolve, total));
  }

  /**
   * §5.4: verify every `expect`. Call at test teardown.
   *
   * @throws HifExpectationError listing every unmet expectation, not just the
   * first — one run should tell you everything that is wrong.
   */
  assertComplete(): void {
    const failures: string[] = [];
    this.fixture.interactions.forEach((interaction, index) => {
      const called = interaction.expect?.called;
      if (called === undefined || called === 'any') return;
      const count = this.plays.get(index) ?? 0;
      const ref = interactionRef(interaction, index);

      if (called === 'once' && count !== 1) failures.push(`${ref}: expected exactly 1 call, got ${count}`);
      else if (called === 'atLeastOnce' && count < 1) failures.push(`${ref}: expected at least 1 call, got 0`);
      else if (called === 'never' && count !== 0) failures.push(`${ref}: expected no calls, got ${count}`);
      else if (typeof called === 'object' && count !== called.times) {
        failures.push(`${ref}: expected exactly ${called.times} call(s), got ${count}`);
      }
    });
    if (failures.length > 0) throw new HifExpectationError(failures);
  }

  /** Interactions that were never played. Useful for pruning stale fixtures. */
  unusedInteractions(): string[] {
    return this.fixture.interactions
      .map((it, i) => (this.plays.get(i) ? null : interactionRef(it, i)))
      .filter((x): x is string => x !== null);
  }

  private explainAll(): boolean {
    if (this.options.explainAll !== undefined) return this.options.explainAll;
    return process.env['SPOOL_EXPLAIN'] === 'all';
  }
}

// ---------------------------------------------------------------------------
// Fault construction (§10)
// ---------------------------------------------------------------------------

/**
 * Node's error codes for the corresponding real conditions.
 *
 * §10 requires raising what the ecosystem's client raises, so that application
 * code catching a connection error catches this one. Where Node has no faithful
 * equivalent the closest code is used and the mapping is documented here rather
 * than hidden.
 */
const FAULT_CODES: Record<Fault['type'], string> = {
  'connection-refused': 'ECONNREFUSED',
  'connection-reset': 'ECONNRESET',
  timeout: 'ETIMEDOUT',
  'dns-failure': 'ENOTFOUND',
  'tls-error': 'ERR_TLS_CERT_ALTNAME_INVALID',
  // No transport-level code exists for a truncated body; the player delivers
  // headers and then errors the body stream with this code.
  'partial-response': 'ECONNRESET',
};

const FAULT_MESSAGES: Record<Fault['type'], string> = {
  'connection-refused': 'connect ECONNREFUSED (simulated by a HIF fixture)',
  'connection-reset': 'socket hang up (simulated by a HIF fixture)',
  timeout: 'request timed out (simulated by a HIF fixture)',
  'dns-failure': 'getaddrinfo ENOTFOUND (simulated by a HIF fixture)',
  'tls-error': 'TLS handshake failed (simulated by a HIF fixture)',
  'partial-response': 'response body truncated (simulated by a HIF fixture)',
};

export function faultError(fault: Fault): HifFaultError {
  return new HifFaultError(fault.type, FAULT_CODES[fault.type], fault.message ?? FAULT_MESSAGES[fault.type]);
}

// ---------------------------------------------------------------------------
// Response delivery (§8.1)
// ---------------------------------------------------------------------------

export interface DeliverableResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

/**
 * Prepare a recorded response for delivery.
 *
 * §8.1: `content-length` is recomputed from the delivered body — a recorded
 * value may disagree after redaction changed it — and `transfer-encoding` and
 * `content-encoding` are dropped, because the stored body is already decoded.
 */
export function deliverable(response: HifResponse, truncate = false): DeliverableResponse {
  const full = response.body ? bodyBytes(response.body) : new Uint8Array(0);
  const body = truncate ? full.slice(0, Math.floor(full.length / 2)) : full;

  const headers: Array<[string, string]> = [];
  for (const entry of response.headers ?? []) {
    const name = String(entry[0]).toLowerCase();
    if (name === 'content-length' || name === 'transfer-encoding' || name === 'content-encoding') continue;
    const value = entry.length === 3 || entry[1] === null ? '' : entry[1];
    headers.push([name, value]);
  }
  if (body.length > 0 || hasRecordedContentLength(response)) {
    headers.push(['content-length', String(body.length)]);
  }

  return {
    status: response.status,
    statusText: response.statusText ?? '',
    headers,
    body,
  };
}

function hasRecordedContentLength(response: HifResponse): boolean {
  return (response.headers ?? []).some((h) => String(h[0]).toLowerCase() === 'content-length');
}
