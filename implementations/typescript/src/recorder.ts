/**
 * The recorder: turning live traffic into a fixture.
 *
 * Redaction (§9) runs here, before anything is written, so credentials never
 * reach disk. The recorder does not offer a "record without redaction" default;
 * disabling it takes an explicit `redact: false`.
 */

import { encodeBody } from './body.js';
import { toEntries } from './headers.js';
import { redactRequest, redactResponse } from './redact.js';
import { serializeFixture } from './fixture.js';
import { SUPPORTED_VERSION } from './fixture.js';
import type { RedactionConfig } from './redact.js';
import type { Body, FaultType, Fixture, HifRequest, HifResponse, Interaction, MatchConfig } from './types.js';

export interface RecorderOptions {
  name?: string;
  /**
   * Redaction rules (§9). Defaults are always applied unless this is `false`,
   * which disables redaction entirely and is never the default.
   */
  redact?: RedactionConfig | false;
  /** Match configuration written into `defaults.match`. */
  defaultMatch?: MatchConfig;
  /** Store bodies as text/base64 rather than parsed JSON (§6.5.2). */
  preserveBytes?: boolean;
  /** Record `timing.latencyMs`. On by default; the value is never used unless simulation is on. */
  recordTiming?: boolean;
  /**
   * Write `meta.createdAt`. Off by default: a changing timestamp produces a
   * spurious diff on every re-record (§3).
   */
  recordTimestamp?: boolean;
  /** Collects §12.3 round-trip warnings and other non-fatal findings. */
  onWarning?: (message: string) => void;
}

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Iterable<[string, string]>;
  body?: Uint8Array;
}

export interface CapturedResponse {
  status: number;
  statusText?: string;
  headers: Iterable<[string, string]>;
  body?: Uint8Array;
}

const RECORDER_NAME = 'spool-typescript';
const RECORDER_VERSION = '0.1.0';

export class Recorder {
  private readonly interactions: Interaction[] = [];
  private readonly options: RecorderOptions;
  readonly warnings: string[] = [];
  private redactionRules = new Set<string>();

  constructor(options: RecorderOptions = {}) {
    this.options = options;
  }

  get size(): number {
    return this.interactions.length;
  }

  /** Record one completed exchange. */
  record(request: CapturedRequest, response: CapturedResponse, latencyMs?: number): Interaction {
    const warn = (m: string): void => {
      this.warnings.push(m);
      this.options.onWarning?.(m);
    };

    const rawRequest: HifRequest = {
      method: request.method.toUpperCase(),
      url: stripFragment(request.url),
      headers: toEntries(request.headers),
      body: encodeBody(request.body ?? new Uint8Array(0), contentTypeOf(request.headers), {
        preserveBytes: this.options.preserveBytes ?? false,
        onWarning: warn,
      }),
    };

    const rawResponse: HifResponse = {
      status: response.status,
      headers: toEntries(response.headers),
      body: encodeBody(response.body ?? new Uint8Array(0), contentTypeOf(response.headers), {
        preserveBytes: this.options.preserveBytes ?? false,
        onWarning: warn,
      }),
    };
    if (response.statusText) rawResponse.statusText = response.statusText;

    const config = this.options.redact === false ? null : (this.options.redact ?? {});
    let finalRequest = rawRequest;
    let finalResponse = rawResponse;

    if (config !== null) {
      const findings: string[] = [];
      finalRequest = redactRequest(rawRequest, config, this.redactionRules, findings);
      finalResponse = redactResponse(rawResponse, config, this.redactionRules, findings);
      for (const f of findings) warn(f);
    }

    const interaction: Interaction = { request: finalRequest, response: finalResponse };
    if ((this.options.recordTiming ?? true) && latencyMs !== undefined) {
      interaction.timing = { latencyMs: Math.round(latencyMs) };
    }

    this.interactions.push(interaction);
    return interaction;
  }

  /** Record a transport failure as a fault interaction (§10). */
  recordFault(request: CapturedRequest, faultType: FaultType): Interaction {
    const config = this.options.redact === false ? null : (this.options.redact ?? {});
    const raw: HifRequest = {
      method: request.method.toUpperCase(),
      url: stripFragment(request.url),
      headers: toEntries(request.headers),
      body: encodeBody(request.body ?? new Uint8Array(0), contentTypeOf(request.headers)),
    };
    const interaction: Interaction = {
      request: config === null ? raw : redactRequest(raw, config, this.redactionRules, []),
      fault: { type: faultType },
    };
    this.interactions.push(interaction);
    return interaction;
  }

  /** Build the fixture. */
  toFixture(): Fixture {
    const fixture: Fixture = {
      hif: SUPPORTED_VERSION,
      meta: {
        recorder: { name: RECORDER_NAME, version: RECORDER_VERSION },
        redaction: {
          applied: this.options.redact !== false && this.redactionRules.size > 0,
          rules: [...this.redactionRules].sort(),
        },
      },
      interactions: this.interactions,
    };
    if (this.options.name) fixture.meta!.name = this.options.name;
    if (this.options.recordTimestamp) fixture.meta!.createdAt = new Date().toISOString();
    if (this.options.defaultMatch) fixture.defaults = { match: this.options.defaultMatch };
    return fixture;
  }

  toJSON(): string {
    return serializeFixture(this.toFixture());
  }

  /**
   * A human-readable summary of what redaction did.
   *
   * Deliberately worded as "reduces exposure", never "safe" or "sanitized"
   * (§9). A fixture recorded against a real system must still be reviewed.
   */
  redactionSummary(): string {
    if (this.options.redact === false) {
      return 'Redaction was DISABLED. This fixture may contain credentials verbatim. Review it before committing.';
    }
    const rules = [...this.redactionRules].sort();
    if (rules.length === 0) {
      return 'No redaction rule matched. This does not mean the fixture is free of secrets — review it before committing.';
    }
    return (
      `Redaction applied (${rules.join(', ')}). Rule- and entropy-based detection have false negatives, ` +
      'so review the fixture before committing it.'
    );
  }
}

function stripFragment(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

function contentTypeOf(headers: Iterable<[string, string]>): string | undefined {
  for (const [name, value] of headers) {
    if (name.toLowerCase() === 'content-type') return value;
  }
  return undefined;
}

/** Convenience for callers that already have a decoded body object. */
export function interactionFrom(request: HifRequest, response: HifResponse, body?: Body): Interaction {
  return { request: body ? { ...request, body } : request, response };
}
