/**
 * HTTP servers that replay or record a fixture, per `spool serve` and
 * `spool proxy`.
 *
 * This is what makes HIF usable from a language with no adapter. Point a client
 * at the server — either by overriding its base URL (`serve`) or by setting
 * `HTTP_PROXY` (`proxy`) — and the fixture backs it, with the same matching,
 * the same explanations and the same redaction as the in-process adapters.
 *
 * Built on `node:http` only. No dependencies, no TLS interception.
 *
 * **The HTTPS limitation is real and is not worked around here.** A forward
 * proxy cannot see inside a CONNECT tunnel without generating a certificate and
 * persuading the client to trust it. Rather than ship a MITM CA — which is a
 * serious thing to put on a developer machine and a worse thing to put in CI —
 * `proxy` answers CONNECT with a clear explanation pointing at `serve`, which
 * needs no such trick.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { deliverable, Player } from './player.js';
import type { PlayerOptions } from './player.js';
import { Recorder } from './recorder.js';
import type { RecorderOptions } from './recorder.js';
import { serializeFixture } from './fixture.js';
import { encodeBody } from './body.js';
import { toEntries } from './headers.js';
import { HifMatchError, HifStructuralError } from './errors.js';
import { normalizeUrl } from './url.js';
import type { Fixture, HifRequest } from './types.js';

export interface ServeOptions extends PlayerOptions {
  port?: number;
  host?: string;
  /**
   * Origin that an incoming request is mapped onto before matching.
   *
   * A client hitting `http://localhost:8080/users/7` must be matched against a
   * fixture recorded from `https://api.example.com/users/7`. Without this the
   * scheme, host and port would never match.
   *
   * When omitted, the origin is inferred if every interaction in the fixture
   * shares one; otherwise construction fails rather than guessing.
   */
  origin?: string;
  /** Called for each request, for logging. */
  onRequest?: (line: string) => void;
}

export interface RunningServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** The origin every interaction shares, or null when they differ. */
export function inferOrigin(fixture: Fixture): string | null {
  const origins = new Set<string>();
  for (const interaction of fixture.interactions) {
    const url = normalizeUrl(interaction.request.url);
    const authority = url.port === null ? url.host : `${url.host}:${url.port}`;
    origins.add(`${url.scheme}://${authority}`);
  }
  return origins.size === 1 ? [...origins][0]! : null;
}

/** Every distinct origin in a fixture, sorted, for diagnostics. */
export function originsOf(fixture: Fixture): string[] {
  const origins = new Set<string>();
  for (const interaction of fixture.interactions) {
    const url = normalizeUrl(interaction.request.url);
    const authority = url.port === null ? url.host : `${url.host}:${url.port}`;
    origins.add(`${url.scheme}://${authority}`);
  }
  return [...origins].sort();
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function headerPairs(request: IncomingMessage): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const raw = request.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    pairs.push([raw[i]!.toLowerCase(), raw[i + 1]!]);
  }
  return pairs;
}

/**
 * Headers a proxy or origin server adds that the fixture never saw.
 *
 * `host` is rewritten by the mapping, and the hop-by-hop headers are transport
 * artefacts. Dropping them keeps `headers: { mode: "all" }` fixtures working
 * through the server exactly as they do in-process.
 */
const TRANSPORT_HEADERS = new Set([
  'host',
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'content-length',
]);

function toHifRequest(
  method: string,
  url: string,
  pairs: Array<[string, string]>,
  body: Uint8Array,
): HifRequest {
  const kept = pairs.filter(([name]) => !TRANSPORT_HEADERS.has(name));
  const contentType = kept.find(([name]) => name === 'content-type')?.[1];
  return {
    method: method.toUpperCase(),
    url,
    headers: toEntries(kept),
    body: encodeBody(body, contentType),
  };
}

function writeDeliverable(
  response: ServerResponse,
  out: ReturnType<typeof deliverable>,
  truncated: boolean,
): void {
  for (const [name, value] of out.headers) {
    // Node computes content-length itself; setting both can conflict.
    if (name === 'content-length') continue;
    response.appendHeader(name, value);
  }
  response.statusCode = out.status;
  if (out.statusText) response.statusMessage = out.statusText;

  if (truncated) {
    // §10 partial-response: send the truncated body then destroy the socket, so
    // the client sees a genuine mid-body failure rather than a short reply.
    response.write(Buffer.from(out.body));
    response.socket?.destroy();
    return;
  }
  response.end(Buffer.from(out.body));
}

function writeMismatch(response: ServerResponse, error: HifMatchError): void {
  // 551 is outside the registered range on purpose: it cannot be confused with
  // a status the recorded API might itself return, so a test that asserts on
  // status codes will not mistake a Spool failure for an application response.
  response.statusCode = 551;
  // Node invents "unknown" as the reason phrase for an unregistered code, and
  // Python invents an empty one. Setting it explicitly keeps the two identical.
  response.statusMessage = 'No Matching Interaction';
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.setHeader('x-spool-error', 'no-matching-interaction');
  response.end(error.message);
}

function writeError(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.setHeader('x-spool-error', 'server-error');
  response.end(message);
}

// ---------------------------------------------------------------------------
// serve: an origin server
// ---------------------------------------------------------------------------

/**
 * Serve a fixture as an HTTP origin.
 *
 * Point your client's base URL at it. This is the mode that works from every
 * language, because it needs nothing from the client but a configurable base
 * URL — and it needs no TLS interception, because the client speaks plain HTTP
 * to localhost while the fixture still describes the original https origin.
 */
export async function serveFixture(fixture: Fixture, options: ServeOptions = {}): Promise<RunningServer> {
  const origin = options.origin ?? inferOrigin(fixture);
  if (!origin) {
    const found = originsOf(fixture);
    throw new HifStructuralError(
      found.length === 0
        ? 'This fixture has no interactions, so serve has no origin to map requests onto. Pass --origin.'
        : `This fixture spans ${found.length} origins (${found.join(', ')}), so serve cannot tell ` +
          'which one an incoming request means. Pass --origin to choose, or use `spool proxy`, ' +
          'where the client sends the full URL and no mapping is needed.',
    );
  }

  const player = new Player(fixture, options);
  const base = normalizeUrl(origin);

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const path = request.url ?? '/';
        const target = `${base.href.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
        const body = await readBody(request);
        const hif = toHifRequest(request.method ?? 'GET', target, headerPairs(request), body);

        options.onRequest?.(`${hif.method} ${path}`);

        const play = player.select(hif);
        await player.delay(play);

        if (play.fault && play.fault.type !== 'partial-response') {
          // A transport fault has no HTTP representation, so the only faithful
          // thing an origin server can do is destroy the connection. The client
          // then sees the socket error it would see for real.
          request.socket.destroy();
          return;
        }

        writeDeliverable(response, deliverable(play.response!, play.fault?.type === 'partial-response'), play.fault?.type === 'partial-response');
      } catch (err) {
        if (err instanceof HifMatchError) writeMismatch(response, err);
        else writeError(response, 500, `spool: ${(err as Error).message}\n`);
      }
    })();
  });

  return listen(server, options, player);
}

// ---------------------------------------------------------------------------
// proxy: a forward proxy
// ---------------------------------------------------------------------------

const CONNECT_EXPLANATION = `spool proxy cannot serve https through a CONNECT tunnel.

Doing so would require generating a TLS certificate and persuading your client
to trust it. Installing a man-in-the-middle certificate authority on a developer
machine or in CI is a bigger security decision than a test tool should make for
you, so spool does not do it.

Two things that do work:

  spool serve fixtures/api.hif.json --origin https://api.example.com
      Serves the fixture as a plain-HTTP origin on localhost. Point your
      client's base URL at it. The fixture still describes the https origin,
      so nothing about the recording changes.

  Use an in-process adapter if your language has one:
      TypeScript: @spool/hif/fetch
      Python:     spool.adapters.httpx_adapter, spool.adapters.requests_adapter
`;

/**
 * Replay through an HTTP forward proxy.
 *
 * Set `HTTP_PROXY=http://localhost:8080` and plain-HTTP requests are matched
 * against the fixture using their absolute-form request URI, which carries the
 * full original URL — so no origin mapping is needed and multi-origin fixtures
 * work.
 *
 * HTTPS is not supported; see `CONNECT_EXPLANATION`.
 */
export async function proxyFixture(fixture: Fixture, options: ServeOptions = {}): Promise<RunningServer> {
  const player = new Player(fixture, options);

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const target = request.url ?? '';
        if (!/^https?:\/\//i.test(target)) {
          writeError(
            response,
            400,
            'spool proxy expects an absolute-form request URI, which is what a client sends to a\n' +
              'forward proxy. This request had a relative path, which means the client is treating\n' +
              'spool as an origin server. Use `spool serve` for that.\n',
          );
          return;
        }

        const body = await readBody(request);
        const hif = toHifRequest(request.method ?? 'GET', target, headerPairs(request), body);
        options.onRequest?.(`${hif.method} ${target}`);

        const play = player.select(hif);
        await player.delay(play);

        if (play.fault && play.fault.type !== 'partial-response') {
          request.socket.destroy();
          return;
        }

        writeDeliverable(response, deliverable(play.response!, play.fault?.type === 'partial-response'), play.fault?.type === 'partial-response');
      } catch (err) {
        if (err instanceof HifMatchError) writeMismatch(response, err);
        else writeError(response, 500, `spool: ${(err as Error).message}\n`);
      }
    })();
  });

  server.on('connect', (_request, socket) => {
    socket.write('HTTP/1.1 501 Not Implemented\r\nContent-Type: text/plain\r\n\r\n');
    socket.write(CONNECT_EXPLANATION);
    socket.end();
  });

  return listen(server, options, player);
}

// ---------------------------------------------------------------------------
// Recording servers
// ---------------------------------------------------------------------------

export interface RecordServeOptions extends RecorderOptions {
  port?: number;
  host?: string;
  /** Upstream origin that requests are forwarded to. Required for serve. */
  origin: string;
  onRequest?: (line: string) => void;
}

export interface RecordingServer extends RunningServer {
  recorder: Recorder;
  toJSON(): string;
  redactionSummary(): string;
}

/**
 * Serve as a recording reverse proxy: forward to `origin`, record what comes
 * back, and hand the client the real response.
 *
 * Redaction runs before anything is stored, exactly as in-process recording
 * does (§9).
 */
export async function recordServe(options: RecordServeOptions): Promise<RecordingServer> {
  const recorder = new Recorder(options);
  const base = normalizeUrl(options.origin);

  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? '/';
      const target = `${base.href.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
      const body = await readBody(request);
      const pairs = headerPairs(request).filter(([name]) => !TRANSPORT_HEADERS.has(name));
      const method = (request.method ?? 'GET').toUpperCase();

      options.onRequest?.(`${method} ${path} -> ${target}`);
      const start = Date.now();

      try {
        const upstream = await fetch(target, {
          method,
          headers: pairs,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          redirect: 'manual',
        });
        const bytes = new Uint8Array(await upstream.arrayBuffer());

        recorder.record(
          { method, url: target, headers: pairs, body },
          {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: [...upstream.headers.entries()] as Array<[string, string]>,
            body: bytes,
          },
          Date.now() - start,
        );

        for (const [name, value] of upstream.headers.entries()) {
          if (TRANSPORT_HEADERS.has(name) || name === 'content-encoding') continue;
          response.appendHeader(name, value);
        }
        response.statusCode = upstream.status;
        response.end(Buffer.from(bytes));
      } catch (err) {
        recorder.recordFault({ method, url: target, headers: pairs, body }, 'connection-reset');
        writeError(response, 502, `spool: upstream request failed: ${(err as Error).message}\n`);
      }
    })();
  });

  const running = await listen(server, options, null);
  return {
    ...running,
    recorder,
    toJSON: () => serializeFixture(recorder.toFixture()),
    redactionSummary: () => recorder.redactionSummary(),
  };
}

// ---------------------------------------------------------------------------

async function listen(
  server: Server,
  options: { port?: number; host?: string },
  player: Player | null,
): Promise<RunningServer> {
  void player;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8080;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
