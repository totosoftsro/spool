import { afterEach, describe, expect, it } from 'vitest';
import { installReplay } from '../src/adapters/fetch.js';
import { HifFaultError, HifMatchError } from '../src/errors.js';
import type { Fixture } from '../src/types.js';

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
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
      id: 'flaky',
      request: { method: 'GET', url: 'https://api.example.com/v1/flaky' },
      fault: { type: 'connection-reset' },
    },
    {
      id: 'no-content',
      request: { method: 'DELETE', url: 'https://api.example.com/v1/users/7' },
      response: { status: 204 },
    },
    {
      id: 'binary',
      request: { method: 'GET', url: 'https://api.example.com/v1/logo.png' },
      response: {
        status: 200,
        headers: [['content-type', 'image/png']],
        // The first eight bytes of a PNG signature.
        body: { encoding: 'base64', base64: 'iVBORw0KGgo=' },
      },
    },
  ],
};

describe('fetch adapter', () => {
  it('replays a JSON response through global fetch', async () => {
    const spool = installReplay(fixture);
    restore = spool.restore;

    const res = await fetch('https://api.example.com/v1/users/7');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ id: 7, name: 'Ada' });
  });

  it('matches a POST by body', async () => {
    const spool = installReplay(fixture);
    restore = spool.restore;

    const res = await fetch('https://api.example.com/v1/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Grace' }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('location')).toBe('/v1/users/8');
  });

  it('accepts a Request object without consuming the caller body', async () => {
    const spool = installReplay(fixture);
    restore = spool.restore;

    const request = new Request('https://api.example.com/v1/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Grace' }),
    });
    const res = await fetch(request);
    expect(res.status).toBe(201);
    expect(request.bodyUsed).toBe(false);
  });

  it('raises a transport-shaped error for a fault (§10)', async () => {
    const spool = installReplay(fixture);
    restore = spool.restore;

    // One call only: the interaction defaults to `times: 1`, so a second call
    // would deplete it and raise a match error instead.
    let caught: unknown;
    try {
      await fetch('https://api.example.com/v1/flaky');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HifFaultError);
    expect((caught as HifFaultError).code).toBe('ECONNRESET');
    expect((caught as HifFaultError).faultType).toBe('connection-reset');
  });

  it('delivers a 204 with no body', async () => {
    const spool = installReplay(fixture);
    restore = spool.restore;

    const res = await fetch('https://api.example.com/v1/users/7', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('delivers binary bodies byte-for-byte', async () => {
    const spool = installReplay(fixture);
    restore = spool.restore;

    const res = await fetch('https://api.example.com/v1/logo.png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('throws an explained error for an unmatched request, without hitting the network', async () => {
    const spool = installReplay(fixture);
    restore = spool.restore;

    await expect(fetch('https://api.example.com/v1/unknown')).rejects.toThrow(HifMatchError);
    try {
      await fetch('https://api.example.com/v1/unknown');
    } catch (err) {
      expect((err as Error).message).toContain('REQUEST MISMATCH');
      expect((err as Error).message).toContain('Closest candidate');
    }
  });

  it('verifies expectations at teardown', async () => {
    const spool = installReplay(fixture);
    restore = spool.restore;

    expect(() => spool.assertComplete()).toThrow(/expected exactly 1 call, got 0/);
    await fetch('https://api.example.com/v1/users/7');
    expect(() => spool.assertComplete()).not.toThrow();
  });

  it('restores the original fetch', () => {
    const before = globalThis.fetch;
    const spool = installReplay(fixture);
    expect(globalThis.fetch).not.toBe(before);
    spool.restore();
    expect(globalThis.fetch).toBe(before);
  });
});

describe('restore() safety', () => {
  it('is idempotent and refuses to clobber a newer interceptor', () => {
    const before = globalThis.fetch;

    const handle = installReplay(fixture);
    handle.restore();
    handle.restore();
    expect(globalThis.fetch).toBe(before);

    const outer = installReplay(fixture);
    const inner = installReplay(fixture);
    expect(() => outer.restore()).toThrow(/reverse order of installation/);
    inner.restore();
    outer.restore();
    expect(globalThis.fetch).toBe(before);
  });
});
