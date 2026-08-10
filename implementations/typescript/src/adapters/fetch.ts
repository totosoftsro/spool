/**
 * The `fetch` adapter.
 *
 * Replaces `globalThis.fetch` with one that plays from a fixture, or records
 * through to the real implementation. This covers Node 18+, Deno, Bun, and any
 * library built on the global `fetch`.
 *
 * It does **not** cover clients that bypass global fetch and use `http.request`
 * directly — axios on Node, node-fetch v2, got, superagent. An adapter for the
 * `http`/`https` modules would cover those, and is a well-scoped contribution;
 * see `docs/contributing-adapters.md`. Saying this plainly here is better than
 * letting someone discover it when their axios test silently hits the network.
 */

import { Player, deliverable, faultError } from '../player.js';
import type { PlayerOptions } from '../player.js';
import { Recorder } from '../recorder.js';
import type { RecorderOptions } from '../recorder.js';
import { parseFixture, serializeFixture } from '../fixture.js';
import type { Fixture, HifRequest } from '../types.js';
import { encodeBody } from '../body.js';
import { toEntries } from '../headers.js';

type FetchFn = typeof globalThis.fetch;

/**
 * `RequestInfo` and `BodyInit` are DOM-library globals that @types/node does not
 * expose. Deriving them from the runtime constructors keeps this file free of a
 * `lib.dom` dependency, which would drag a browser type surface into a Node
 * package.
 */
type FetchInput = Request | URL | string;
type ResponseBodyInit = ConstructorParameters<typeof Response>[0];

export interface ReplayHandle {
  player: Player;
  /** Restore the previous global `fetch`. */
  restore(): void;
  /** §5.4: verify every `expect`. Throws `HifExpectationError` on failure. */
  assertComplete(): void;
  /** Interaction refs that were never played. */
  unused(): string[];
}

export interface RecordHandle {
  recorder: Recorder;
  restore(): void;
  /** Serialize the recorded fixture. */
  toJSON(): string;
  /** A summary of what redaction did. Never claims the fixture is safe. */
  redactionSummary(): string;
}

/**
 * Install a fetch that replays from `fixture`.
 *
 * Unmatched requests throw `HifMatchError` with the §13 explanation rendered
 * into the message. Nothing reaches the network.
 */
export function installReplay(fixture: Fixture | string, options: PlayerOptions = {}): ReplayHandle {
  const parsed = typeof fixture === 'string' ? parseFixture(fixture).fixture : fixture;
  const player = new Player(parsed, options);
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const request = await toHifRequest(input, init);
    const play = player.select(request);
    await player.delay(play);

    if (play.fault && play.fault.type !== 'partial-response') {
      throw faultError(play.fault);
    }

    const response = play.response!;
    const out = deliverable(response, play.fault?.type === 'partial-response');

    const headers = new Headers();
    for (const [name, value] of out.headers) headers.append(name, value);

    // 204/304 must not carry a body, and the Response constructor enforces it.
    const bodyInit = out.status === 204 || out.status === 304 || out.body.length === 0 ? null : out.body;

    return new Response(bodyInit, {
      status: out.status,
      statusText: out.statusText,
      headers,
    });
  }) as FetchFn;

  return {
    player,
    restore(): void {
      globalThis.fetch = original;
    },
    assertComplete(): void {
      player.assertComplete();
    },
    unused(): string[] {
      return player.unusedInteractions();
    },
  };
}

/**
 * Install a fetch that performs real requests and records them.
 *
 * Redaction runs before anything is stored (§9). Passing `redact: false` is the
 * only way to disable it.
 */
export function installRecord(options: RecorderOptions = {}): RecordHandle {
  const recorder = new Recorder(options);
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const captured = await readRequest(input, init);
    const start = Date.now();

    let response: Response;
    try {
      response = await original(input as Request | string, init);
    } catch (err) {
      // A real transport failure is recorded as a fault so the fixture can
      // reproduce it later (§10). The error still propagates.
      recorder.recordFault(captured, classifyError(err));
      throw err;
    }

    const latency = Date.now() - start;
    const bytes = new Uint8Array(await response.clone().arrayBuffer());

    recorder.record(
      captured,
      {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()] as Array<[string, string]>,
        body: bytes,
      },
      latency,
    );

    return response;
  }) as FetchFn;

  return {
    recorder,
    restore(): void {
      globalThis.fetch = original;
    },
    toJSON(): string {
      return serializeFixture(recorder.toFixture());
    },
    redactionSummary(): string {
      return recorder.redactionSummary();
    },
  };
}

/** Map a thrown fetch error onto the closest HIF fault type (§10). */
function classifyError(err: unknown): 'connection-refused' | 'connection-reset' | 'timeout' | 'dns-failure' | 'tls-error' {
  const message = String((err as { cause?: { code?: string } })?.cause?.code ?? (err as Error)?.message ?? '');
  if (message.includes('ECONNREFUSED')) return 'connection-refused';
  if (message.includes('ENOTFOUND') || message.includes('EAI_AGAIN')) return 'dns-failure';
  if (message.includes('ETIMEDOUT') || message.includes('TimeoutError')) return 'timeout';
  if (message.includes('CERT') || message.includes('TLS') || message.includes('SSL')) return 'tls-error';
  return 'connection-reset';
}

async function toHifRequest(input: FetchInput, init?: RequestInit): Promise<HifRequest> {
  const { url, method, headers, body } = await readRequest(input, init);
  const contentType = headers.find(([n]) => n === 'content-type')?.[1];
  return {
    method,
    url,
    headers: toEntries(headers),
    body: encodeBody(body, contentType),
  };
}

/**
 * Normalize the several shapes `fetch` accepts into one.
 *
 * `Request` objects are cloned before their body is read, because a body is a
 * one-shot stream and consuming it here would break the caller.
 */
async function readRequest(
  input: FetchInput,
  init?: RequestInit,
): Promise<{ url: string; method: string; headers: Array<[string, string]>; body: Uint8Array }> {
  if (input instanceof Request) {
    const clone = input.clone();
    return {
      url: clone.url,
      method: clone.method.toUpperCase(),
      headers: [...clone.headers.entries()] as Array<[string, string]>,
      body: new Uint8Array(await clone.arrayBuffer()),
    };
  }

  const url = input instanceof URL ? input.href : String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Array<[string, string]> = [];
  if (init?.headers) {
    for (const [name, value] of new Headers(init.headers).entries()) {
      headers.push([name, value]);
    }
  }

  let body = new Uint8Array(0);
  if (init?.body !== undefined && init.body !== null) {
    body = new Uint8Array(await new Response(init.body as ResponseBodyInit).arrayBuffer());
  }

  return { url, method, headers, body };
}
