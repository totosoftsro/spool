/**
 * Tests for the `node:http` adapter.
 *
 * The point of this adapter is the clients it unlocks, so the important tests
 * here drive it through axios rather than through `http.request` directly.
 */

import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { installNodeHttpReplay } from '../src/adapters/node-http.js';
import type { NodeHttpHandle } from '../src/adapters/node-http.js';
import { HifMatchError } from '../src/errors.js';
import type { Fixture } from '../src/types.js';

let spool: NodeHttpHandle | null = null;

afterEach(() => {
  spool?.restore();
  spool = null;
});

const fixture: Fixture = {
  hif: '1.0',
  interactions: [
    {
      id: 'get-user',
      request: { method: 'GET', url: 'https://api.example.com/v1/users/7' },
      response: {
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'application/json']],
        body: { encoding: 'json', json: { id: 7, name: 'Ada' } },
      },
      expect: { called: 'once' },
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
      id: 'repeated-header',
      request: { method: 'GET', url: 'https://api.example.com/v1/session' },
      response: {
        status: 200,
        headers: [
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
        ],
      },
    },
    {
      id: 'flaky',
      request: { method: 'GET', url: 'https://api.example.com/v1/flaky' },
      fault: { type: 'connection-reset' },
    },
    {
      id: 'plain-http',
      request: { method: 'GET', url: 'http://api.example.com/v1/plain' },
      response: { status: 200, body: { encoding: 'text', text: 'plain' } },
    },
    {
      id: 'with-port',
      request: { method: 'GET', url: 'https://api.example.com:8443/v1/ported' },
      response: { status: 200, body: { encoding: 'text', text: 'ported' } },
    },
  ],
};

/** Drive `http.request` directly and collect the whole response. */
function request(
  options: string | http.RequestOptions,
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; raw: string[] }> {
  return new Promise((resolve, reject) => {
    const req = https_request(options);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
          raw: res.rawHeaders,
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function https_request(options: string | http.RequestOptions): http.ClientRequest {
  // Imported lazily through the module object so the patched function is used.
  const mod = typeof options === 'string' && options.startsWith('http://') ? http : require('node:https');
  return mod.request(options as never);
}

describe('node:http adapter', () => {
  it('replays a JSON response through http.request', async () => {
    spool = installNodeHttpReplay(fixture);

    const response = await request('https://api.example.com/v1/users/7');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json');
    expect(JSON.parse(response.text)).toEqual({ id: 7, name: 'Ada' });
  });

  it('matches a POST by body written with req.write', async () => {
    spool = installNodeHttpReplay(fixture);

    const response = await request(
      {
        protocol: 'https:',
        hostname: 'api.example.com',
        path: '/v1/users',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({ name: 'Grace' }),
    );

    expect(response.status).toBe(201);
    expect(response.headers['location']).toBe('/v1/users/8');
  });

  it('preserves repeated headers as an array, like a real response', async () => {
    spool = installNodeHttpReplay(fixture);

    const response = await request('https://api.example.com/v1/session');

    expect(response.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(response.raw).toContain('set-cookie');
  });

  it('raises an error with a Node error code for a fault', async () => {
    spool = installNodeHttpReplay(fixture);

    await expect(request('https://api.example.com/v1/flaky')).rejects.toMatchObject({
      code: 'ECONNRESET',
    });
  });

  it('handles plain http and a non-default port', async () => {
    spool = installNodeHttpReplay(fixture);

    const plain = await request('http://api.example.com/v1/plain');
    expect(plain.text).toBe('plain');

    const ported = await request({
      protocol: 'https:',
      hostname: 'api.example.com',
      port: 8443,
      path: '/v1/ported',
    });
    expect(ported.text).toBe('ported');
  });

  it('explains an unmatched request instead of hitting the network', async () => {
    spool = installNodeHttpReplay(fixture);

    await expect(request('https://api.example.com/v1/unknown')).rejects.toBeInstanceOf(HifMatchError);
    try {
      await request('https://api.example.com/v1/unknown');
    } catch (error) {
      expect((error as Error).message).toContain('REQUEST MISMATCH');
      expect((error as Error).message).toContain('Closest candidate');
    }
  });

  it('restores the original functions', () => {
    const before = { request: http.request, get: http.get };
    const handle = installNodeHttpReplay(fixture);
    expect(http.request).not.toBe(before.request);
    handle.restore();
    expect(http.request).toBe(before.request);
    expect(http.get).toBe(before.get);
  });

  it('verifies expectations', async () => {
    spool = installNodeHttpReplay(fixture);
    expect(() => spool!.assertComplete()).toThrow(/expected exactly 1 call, got 0/);
    await request('https://api.example.com/v1/users/7');
    expect(() => spool!.assertComplete()).not.toThrow();
  });
});

describe('node:http adapter through axios', () => {
  it('works with the client this adapter exists for', async () => {
    // axios is a devDependency purely so this test can prove the claim in the
    // README: that this adapter covers clients built on node:http. It is a hard
    // requirement of the test rather than an optional skip, because a silently
    // skipped test here would let the README claim go unverified.
    const axios = (await import('axios')).default;
    expect(axios).toBeDefined();

    spool = installNodeHttpReplay(fixture);

    const response = await axios.get('https://api.example.com/v1/users/7');
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ id: 7, name: 'Ada' });

    const created = await axios.post('https://api.example.com/v1/users', { name: 'Grace' });
    expect(created.status).toBe(201);
    expect(created.headers['location']).toBe('/v1/users/8');

    await expect(axios.get('https://api.example.com/v1/flaky')).rejects.toMatchObject({
      code: 'ECONNRESET',
    });
  });
});

describe('restore() safety', () => {
  // A leaked patch is the worst failure this library can have: a later test keeps
  // replaying an earlier fixture and *passes* against the wrong data. These
  // guard the two ways it used to happen.

  it('is idempotent', () => {
    const before = http.request;
    const handle = installNodeHttpReplay(fixture);
    handle.restore();
    handle.restore();
    expect(http.request).toBe(before);
  });

  it('restores cleanly when nested handles unwind in reverse order', () => {
    const before = http.request;
    const outer = installNodeHttpReplay(fixture);
    const inner = installNodeHttpReplay(fixture);
    inner.restore();
    outer.restore();
    expect(http.request).toBe(before);
  });

  it('refuses to clobber an interceptor installed after it', () => {
    // Restoring the outer handle first used to reinstate *its* patch and discard
    // the inner one, leaving node:http permanently patched — and every later
    // install then captured the leaked patch as its "original".
    const before = http.request;
    const outer = installNodeHttpReplay(fixture);
    const inner = installNodeHttpReplay(fixture);

    expect(() => outer.restore()).toThrow(/reverse order of installation/);

    inner.restore();
    outer.restore();
    expect(http.request).toBe(before);
  });
});
