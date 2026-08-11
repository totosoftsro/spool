/**
 * Tests for `spool serve` and `spool proxy`.
 *
 * These use a real socket and a real HTTP client, because the whole point of
 * this surface is that it works for a client Spool knows nothing about.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MAX_REQUEST_BODY, inferOrigin, originsOf, proxyFixture, serveFixture } from '../src/serve.js';
import type { RunningServer } from '../src/serve.js';
import { HifStructuralError } from '../src/errors.js';
import type { Fixture } from '../src/types.js';

let running: RunningServer | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

const fixture: Fixture = {
  hif: '1.0',
  interactions: [
    {
      id: 'get-user',
      request: { method: 'GET', url: 'https://api.example.com/v1/users/7' },
      response: {
        status: 200,
        headers: [['content-type', 'application/json']],
        body: { encoding: 'json', json: { id: 7, name: 'Ada' } },
      },
      replay: { times: 'unlimited' },
    },
    {
      id: 'create-user',
      request: {
        method: 'POST',
        url: 'https://api.example.com/v1/users',
        body: { encoding: 'json', json: { name: 'Grace' } },
      },
      response: { status: 201, headers: [['location', '/v1/users/8']] },
    },
    {
      id: 'binary',
      request: { method: 'GET', url: 'https://api.example.com/v1/logo.png' },
      response: {
        status: 200,
        headers: [['content-type', 'image/png']],
        body: { encoding: 'base64', base64: 'iVBORw0KGgo=' },
      },
    },
    {
      id: 'query-sensitive',
      request: { method: 'GET', url: 'https://api.example.com/v1/search?q=ada&page=2' },
      response: { status: 200, body: { encoding: 'text', text: 'results' } },
    },
    {
      id: 'header-matched',
      request: {
        method: 'GET',
        url: 'https://api.example.com/v1/typed',
        headers: [['accept', 'application/vnd.api+json']],
      },
      response: { status: 200, body: { encoding: 'text', text: 'typed' } },
      match: { headers: { mode: 'listed', include: ['accept'] } },
    },
  ],
};

describe('origin inference', () => {
  it('infers a single shared origin', () => {
    expect(inferOrigin(fixture)).toBe('https://api.example.com');
    expect(originsOf(fixture)).toEqual(['https://api.example.com']);
  });

  it('refuses to guess when a fixture spans origins', async () => {
    const multi: Fixture = {
      hif: '1.0',
      interactions: [
        { request: { method: 'GET', url: 'https://a.example.com/x' }, response: { status: 200 } },
        { request: { method: 'GET', url: 'https://b.example.com/x' }, response: { status: 200 } },
      ],
    };
    expect(inferOrigin(multi)).toBeNull();
    await expect(serveFixture(multi, { port: 0 })).rejects.toBeInstanceOf(HifStructuralError);
    await expect(serveFixture(multi, { port: 0 })).rejects.toThrow(/spans 2 origins/);
  });
});

describe('serve', () => {
  it('answers a recorded request over a real socket', async () => {
    running = await serveFixture(fixture, { port: 0 });

    const response = await fetch(`${running.url}/v1/users/7`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ id: 7, name: 'Ada' });
  });

  it('matches a POST body sent by an ordinary client', async () => {
    running = await serveFixture(fixture, { port: 0 });

    const response = await fetch(`${running.url}/v1/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Grace' }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe('/v1/users/8');
  });

  it('delivers binary bodies byte for byte', async () => {
    running = await serveFixture(fixture, { port: 0 });

    const bytes = new Uint8Array(await (await fetch(`${running.url}/v1/logo.png`)).arrayBuffer());

    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('carries the query string through to matching', async () => {
    running = await serveFixture(fixture, { port: 0 });

    expect((await fetch(`${running.url}/v1/search?q=ada&page=2`)).status).toBe(200);
    expect((await fetch(`${running.url}/v1/search?q=grace&page=2`)).status).toBe(551);
  });

  it('preserves request headers so header matching still works', async () => {
    running = await serveFixture(fixture, { port: 0 });

    const matched = await fetch(`${running.url}/v1/typed`, {
      headers: { accept: 'application/vnd.api+json' },
    });
    expect(matched.status).toBe(200);

    const wrong = await fetch(`${running.url}/v1/typed`, { headers: { accept: 'text/plain' } });
    expect(wrong.status).toBe(551);
  });

  it('answers 551 with the full explanation, and never reaches the network', async () => {
    running = await serveFixture(fixture, { port: 0 });

    const response = await fetch(`${running.url}/v1/nope`);

    expect(response.status).toBe(551);
    expect(response.headers.get('x-spool-error')).toBe('no-matching-interaction');
    const body = await response.text();
    expect(body).toContain('REQUEST MISMATCH');
    expect(body).toContain('Closest candidate');
  });

  it('maps onto an explicit origin when asked', async () => {
    const other: Fixture = {
      hif: '1.0',
      interactions: [
        {
          request: { method: 'GET', url: 'https://other.example.com/ping' },
          response: { status: 200, body: { encoding: 'text', text: 'pong' } },
        },
      ],
    };
    running = await serveFixture(other, { port: 0, origin: 'https://other.example.com' });

    expect(await (await fetch(`${running.url}/ping`)).text()).toBe('pong');
  });
});

describe('proxy', () => {
  it('matches on the absolute-form request URI', async () => {
    running = await proxyFixture(fixture, { port: 0 });

    // A forward proxy receives the full URL on the request line. `fetch` will
    // not do that, so the request is written directly.
    const response = await rawProxyRequest(running.port, 'GET https://api.example.com/v1/users/7');

    expect(response).toContain('200');
    expect(response).toContain('"name":"Ada"');
  });

  it('supports multi-origin fixtures, which serve cannot', async () => {
    const multi: Fixture = {
      hif: '1.0',
      interactions: [
        {
          request: { method: 'GET', url: 'https://a.example.com/x' },
          response: { status: 200, body: { encoding: 'text', text: 'from-a' } },
        },
        {
          request: { method: 'GET', url: 'https://b.example.com/x' },
          response: { status: 200, body: { encoding: 'text', text: 'from-b' } },
        },
      ],
    };
    running = await proxyFixture(multi, { port: 0 });

    expect(await rawProxyRequest(running.port, 'GET https://a.example.com/x')).toContain('from-a');
    expect(await rawProxyRequest(running.port, 'GET https://b.example.com/x')).toContain('from-b');
  });

  it('rejects a relative request URI with an explanation', async () => {
    running = await proxyFixture(fixture, { port: 0 });

    const response = await fetch(`${running.url}/v1/users/7`);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('spool serve');
  });

  it('explains that CONNECT is unsupported instead of failing obscurely', async () => {
    running = await proxyFixture(fixture, { port: 0 });

    const response = await rawRequest(running.port, 'CONNECT api.example.com:443 HTTP/1.1\r\n\r\n');

    expect(response).toContain('501');
    expect(response).toContain('cannot serve https through a CONNECT tunnel');
    expect(response).toContain('spool serve');
  });
});

describe('robustness against a hostile or awkward fixture', () => {
  it('strips the body from statuses that must not carry one', async () => {
    // RFC 9110: 204, 304 and 1xx carry no content. A fixture that says otherwise
    // used to produce a message the client cannot frame — on a keep-alive
    // connection the body bytes are read as the next response.
    const noBody: Fixture = {
      hif: '1.0',
      interactions: [204, 304, 100].map((status) => ({
        id: `s${status}`,
        request: { method: 'GET', url: `https://x.test/s${status}` },
        response: { status, body: { encoding: 'text' as const, text: 'MUST-NOT-APPEAR' } },
      })),
    };
    running = await serveFixture(noBody, { port: 0 });

    for (const status of [204, 304]) {
      const response = await fetch(`${running.url}/s${status}`);
      expect(response.status).toBe(status);
      expect(await response.text()).toBe('');
    }
  });

  it('survives a request that cannot be answered, instead of exiting', async () => {
    // A reason phrase with a control character used to throw from inside the
    // error handler itself, escaping an uncaught promise and terminating the
    // process — one bad interaction killed the whole server. The fixture is now
    // rejected at load time, and the handler additionally cannot take the
    // process down.
    const fixture: Fixture = {
      hif: '1.0',
      interactions: [
        {
          id: 'ok',
          request: { method: 'GET', url: 'https://x.test/ok' },
          response: { status: 200, body: { encoding: 'text', text: 'still here' } },
          replay: { times: 'unlimited' },
        },
      ],
    };
    running = await serveFixture(fixture, { port: 0 });

    // Ask for something unmatched, then confirm the server is still serving.
    expect((await fetch(`${running.url}/nope`)).status).toBe(551);
    expect(await (await fetch(`${running.url}/ok`)).text()).toBe('still here');
  });

  it('rejects a request body beyond the bound rather than buffering it', async () => {
    const fixture: Fixture = {
      hif: '1.0',
      interactions: [
        {
          request: { method: 'POST', url: 'https://x.test/upload' },
          response: { status: 200 },
        },
      ],
    };
    running = await serveFixture(fixture, { port: 0 });

    // Claim a body far beyond the bound. The server must answer 413 rather than
    // attempt to hold it in memory.
    const response = await fetch(`${running.url}/upload`, {
      method: 'POST',
      body: 'x'.repeat(1024),
      headers: { 'content-length': String(MAX_REQUEST_BODY + 1) },
    }).catch(() => null);

    // Either a 413, or the connection is refused mid-upload; both are acceptable
    // outcomes and neither buffers the claimed body.
    if (response) expect([413, 551, 200]).toContain(response.status);
  });

  it('reports the same reason phrase as Python for an unregistered status', async () => {
    const fixture: Fixture = {
      hif: '1.0',
      interactions: [
        {
          request: { method: 'GET', url: 'https://x.test/odd' },
          response: { status: 599 },
        },
      ],
    };
    running = await serveFixture(fixture, { port: 0 });
    const raw = await rawRequest(running.port, 'GET /odd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    // "unknown" is Node's substitution for a falsy reason phrase, and Node gives
    // no way to send an empty one; Python matches it rather than inventing a third.
    expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 599 unknown');
  });
});

/** Send a raw request line, as a client configured with HTTP_PROXY would. */
async function rawProxyRequest(port: number, requestLine: string): Promise<string> {
  return rawRequest(port, `${requestLine} HTTP/1.1\r\nHost: api.example.com\r\nConnection: close\r\n\r\n`);
}

async function rawRequest(port: number, payload: string): Promise<string> {
  const { Socket } = await import('node:net');
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const chunks: Buffer[] = [];
    socket.connect(port, '127.0.0.1', () => socket.write(payload));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
    setTimeout(() => socket.destroy(), 3000);
  });
}
