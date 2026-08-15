/**
 * The `node:http` / `node:https` adapter.
 *
 * The `fetch` adapter covers anything built on global fetch. This one covers
 * everything else on Node: axios, got, node-fetch v2, superagent, and the
 * `http` module directly — because all of them ultimately call
 * `http.request` or `https.request`.
 *
 * Unlike the `fetch` adapter, this one has no documented extension seam to use:
 * Node's `http` module offers no interception hook, so the module functions are
 * replaced and restored. That is a real cost, and the reason the `fetch`
 * adapter is preferred where it applies.
 *
 * The response handed to callers is a genuine `http.IncomingMessage` over a
 * detached socket, rather than an emulation of one. Clients poke at these
 * objects in surprising ways — `res.socket`, `res.rawHeaders`, backpressure —
 * and a real instance behaves correctly under all of it.
 */

import http from 'node:http';
import https from 'node:https';
import { Writable } from 'node:stream';
import { Socket } from 'node:net';

import { encodeBody } from '../body.js';
import { HifFaultError, HifMatchError } from '../errors.js';
import { parseFixture } from '../fixture.js';
import { deliverable, faultError, Player } from '../player.js';
import type { PlayerOptions } from '../player.js';
import type { Fixture, HifRequest } from '../types.js';

type RequestFn = typeof http.request;

export interface NodeHttpHandle {
  player: Player;
  /** Restore the original `http.request`, `http.get`, and the https pair. */
  restore(): void;
  /** §5.4: verify every `expect`. Throws `HifExpectationError` on failure. */
  assertComplete(): void;
  /** Interaction refs that were never played. */
  unused(): string[];
}

interface Saved {
  httpRequest: RequestFn;
  httpGet: RequestFn;
  httpsRequest: RequestFn;
  httpsGet: RequestFn;
}

/**
 * Normalize the several shapes `http.request` accepts into a URL and options.
 *
 * Supported call forms, all of which real clients use:
 *   request(url)                     request(url, callback)
 *   request(options)                 request(options, callback)
 *   request(url, options)            request(url, options, callback)
 */
function parseArgs(
  scheme: 'http' | 'https',
  args: unknown[],
): { url: string; options: http.RequestOptions; callback?: (res: http.IncomingMessage) => void } {
  let url: URL | null = null;
  let options: http.RequestOptions = {};
  let callback: ((res: http.IncomingMessage) => void) | undefined;

  for (const arg of args) {
    if (typeof arg === 'function') {
      callback = arg as (res: http.IncomingMessage) => void;
    } else if (typeof arg === 'string') {
      url = new URL(arg);
    } else if (arg instanceof URL) {
      url = arg;
    } else if (arg && typeof arg === 'object') {
      options = { ...options, ...(arg as http.RequestOptions) };
    }
  }

  const protocol = (options.protocol ?? url?.protocol ?? `${scheme}:`).replace(/:$/, '');
  const hostname = options.hostname ?? options.host ?? url?.hostname ?? 'localhost';
  const port = options.port ?? (url?.port ? Number(url.port) : undefined);
  const path = options.path ?? (url ? `${url.pathname}${url.search}` : '/');

  // `host` may carry a port; `hostname` never does.
  const bareHost = String(hostname).replace(/:\d+$/, '');
  const authority = port === undefined || port === null || port === '' ? bareHost : `${bareHost}:${port}`;

  return { url: `${protocol}://${authority}${path}`, options, callback };
}

function headersFrom(options: http.RequestOptions): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) out.push([name.toLowerCase(), String(item)]);
    } else {
      out.push([name.toLowerCase(), String(value)]);
    }
  }
  return out;
}

/**
 * A stand-in for `http.ClientRequest`.
 *
 * Extends `Writable` so that `req.write()`, `req.end()`, `pipe()` into it, and
 * backpressure all behave. The fixture is consulted once the body is complete,
 * which is the earliest point at which body matching is possible.
 */
class FakeClientRequest extends Writable {
  private readonly chunks: Buffer[] = [];
  private readonly headers = new Map<string, string | string[]>();
  private settled = false;

  constructor(
    private readonly player: Player,
    private readonly url: string,
    private readonly method: string,
    initialHeaders: Array<[string, string]>,
    callback?: (res: http.IncomingMessage) => void,
  ) {
    super();
    for (const [name, value] of initialHeaders) this.headers.set(name, value);
    if (callback) this.once('response', callback);
  }

  // --- OutgoingMessage surface that clients commonly use --------------------

  setHeader(name: string, value: string | string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    return this.headers.get(name.toLowerCase());
  }

  getHeaders(): Record<string, string | string[]> {
    return Object.fromEntries(this.headers);
  }

  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
  }

  /** No-op: there is no socket to configure, and clients call this routinely. */
  setNoDelay(): void {}
  setSocketKeepAlive(): void {}

  /**
   * A timeout can never fire, because a fixture answers immediately. Recording
   * the listener and doing nothing is the honest behaviour — pretending to time
   * out would be inventing a fault the fixture did not describe. Use a
   * `timeout` fault (§10) to test timeout handling.
   */
  setTimeout(_ms: number, listener?: () => void): this {
    if (listener) this.once('timeout', listener);
    return this;
  }

  abort(): void {
    this.destroy();
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, next: (error?: Error) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    next();
  }

  override _final(next: (error?: Error) => void): void {
    next();
    // Deferred so that a caller doing `req.end(); req.on('response', ...)` in
    // the same tick still has its listener attached when the event fires.
    // Synchronous emission here would lose the response for such callers, and
    // that pattern is common.
    setImmediate(() => this.settle());
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;

    const body = Buffer.concat(this.chunks);
    const headerPairs = [...this.headers.entries()].flatMap(([name, value]) =>
      Array.isArray(value)
        ? value.map((v): [string, string] => [name, String(v)])
        : [[name, String(value)] as [string, string]],
    );
    const contentType = headerPairs.find(([name]) => name === 'content-type')?.[1];

    const request: HifRequest = {
      method: this.method,
      url: this.url,
      headers: headerPairs,
      body: encodeBody(new Uint8Array(body), contentType),
    };

    let play;
    try {
      play = this.player.select(request);
    } catch (err) {
      // Both a match failure and a structural error surface as a request error,
      // because that is the only channel `http.request` gives us. The message
      // still carries the full §13 explanation.
      this.emit('error', err instanceof HifMatchError ? err : (err as Error));
      return;
    }

    void this.player.delay(play).then(() => {
      if (play.fault && play.fault.type !== 'partial-response') {
        this.emit('error', asNodeError(faultError(play.fault)));
        return;
      }

      const out = deliverable(play.response!, play.fault?.type === 'partial-response');
      const response = new http.IncomingMessage(new Socket());
      response.statusCode = out.status;
      response.statusMessage = out.statusText || http.STATUS_CODES[out.status] || '';
      response.httpVersion = '1.1';
      response.httpVersionMajor = 1;
      response.httpVersionMinor = 1;

      for (const [name, value] of out.headers) {
        response.rawHeaders.push(name, value);
        const existing = response.headers[name];
        if (existing === undefined) {
          response.headers[name] = value;
        } else if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          response.headers[name] = [existing, value];
        }
      }

      this.emit('response', response);
      response.push(Buffer.from(out.body));

      if (play.fault?.type === 'partial-response') {
        // §10: headers arrive, then the body is cut off. Erroring the stream
        // rather than ending it is what makes a client's retry logic fire.
        response.destroy(asNodeError(faultError(play.fault)));
        return;
      }
      response.push(null);
    });
  }
}

/** Give a HIF fault the `code` property Node's own errors carry. */
function asNodeError(error: HifFaultError): NodeJS.ErrnoException {
  const out: NodeJS.ErrnoException = new Error(error.message);
  out.code = error.code;
  out.name = 'Error';
  (out as { cause?: unknown }).cause = error;
  return out;
}

/**
 * Install replay over `http.request`, `http.get` and their https counterparts.
 *
 * Returns a handle whose `restore()` puts the originals back. Always restore in
 * a `finally` or an `afterEach`: a leaked patch makes later tests fail in
 * confusing ways.
 */
export function installNodeHttpReplay(fixture: Fixture | string, options: PlayerOptions = {}): NodeHttpHandle {
  const parsed = typeof fixture === 'string' ? parseFixture(fixture).fixture : fixture;
  const player = new Player(parsed, options);

  const saved: Saved = {
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
  };

  const make = (scheme: 'http' | 'https', autoEnd: boolean) =>
    function patched(...args: unknown[]): http.ClientRequest {
      const { url, options: requestOptions, callback } = parseArgs(scheme, args);
      const request = new FakeClientRequest(
        player,
        url,
        String(requestOptions.method ?? (autoEnd ? 'GET' : 'GET')).toUpperCase(),
        headersFrom(requestOptions),
        callback,
      );
      // `http.get` differs from `http.request` only in calling end() for you.
      if (autoEnd) setImmediate(() => request.end());
      return request as unknown as http.ClientRequest;
    } as unknown as RequestFn;

  const installed = {
    httpRequest: make('http', false),
    httpGet: make('http', true),
    httpsRequest: make('https', false),
    httpsGet: make('https', true),
  };

  http.request = installed.httpRequest;
  http.get = installed.httpGet;
  https.request = installed.httpsRequest;
  https.get = installed.httpsGet;

  let restored = false;

  return {
    player,
    restore(): void {
      // Idempotent: a second call is a no-op rather than reinstalling whatever
      // this handle happened to capture.
      if (restored) return;

      // If something else was installed on top of us, putting our saved
      // functions back would revive *our* patch and discard theirs. Left
      // unchecked that is silent and severe: a later test keeps replaying an
      // earlier fixture and passes against the wrong data. Fail loudly instead.
      if (http.request !== installed.httpRequest) {
        throw new Error(
          'spool: cannot restore node:http because another interceptor was installed after this ' +
            'one. Restore in reverse order of installation — the innermost handle first. Leaving ' +
            'this unchecked would reinstate this adapter and silently replay the wrong fixture.',
        );
      }

      restored = true;
      http.request = saved.httpRequest;
      http.get = saved.httpGet;
      https.request = saved.httpsRequest;
      https.get = saved.httpsGet;
    },
    assertComplete(): void {
      player.assertComplete();
    },
    unused(): string[] {
      return player.unusedInteractions();
    },
  };
}
