/**
 * HAR import tests.
 *
 * HAR conversion is Appendix B of the specification, which is informative
 * rather than normative, so it is not part of the conformance suite. It is
 * still compared between implementations by `conformance/cross-check.sh`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importHar, importHarText } from '../src/har.js';
import { validateFixture } from '../src/fixture.js';
import { HifStructuralError } from '../src/errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(HERE, '..', '..', '..', 'conformance', 'fixtures', 'sample.har'), 'utf8');

describe('HAR import', () => {
  it('produces a fixture that passes validation', () => {
    const { fixture } = importHarText(SAMPLE);
    expect(() => validateFixture(fixture)).not.toThrow();
    expect(fixture.hif).toBe('1.0');
  });

  it('converts request and response faithfully', () => {
    const { fixture } = importHarText(SAMPLE);
    const first = fixture.interactions[0]!;

    expect(first.request.method).toBe('GET');
    expect(first.request.url).toBe('https://api.example.com/v1/users/7?_=1723280000');
    expect(first.response!.status).toBe(200);
    expect(first.response!.body).toEqual({
      encoding: 'json',
      json: { id: 7, name: 'Ada' },
      contentType: 'application/json',
    });
  });

  it('collapses HAR timings into latencyMs', () => {
    const { fixture } = importHarText(SAMPLE);
    expect(fixture.interactions[0]!.timing).toEqual({ latencyMs: 188 });
  });

  it('drops HTTP/2 pseudo-headers, which are not fields', () => {
    const { fixture } = importHarText(SAMPLE);
    const names = (fixture.interactions[0]!.request.headers ?? []).map((h) => h[0]);
    expect(names).not.toContain(':method');
    expect(names).toContain('accept');
  });

  it('flattens cookie objects into a cookie header', () => {
    const { fixture } = importHarText(SAMPLE);
    const cookie = (fixture.interactions[0]!.request.headers ?? []).find((h) => h[0] === 'cookie');
    expect(cookie?.[1]).toBe('session=abc123def456');
  });

  it('drops content-encoding, because the stored body is decoded (§8.1)', () => {
    const { fixture } = importHarText(SAMPLE);
    const names = (fixture.interactions[0]!.response!.headers ?? []).map((h) => h[0]);
    expect(names).not.toContain('content-encoding');
    expect(names).toContain('content-type');
  });

  it('reassembles postData params into a form body', () => {
    const { fixture } = importHarText(SAMPLE);
    const body = fixture.interactions[1]!.request.body as { encoding: string; text: string };
    expect(body.encoding).toBe('text');
    expect(body.text).toBe('name=Grace&password=hunter2');
  });

  it('skips cache hits, non-http schemes and aborted requests, and says why', () => {
    const { skipped } = importHarText(SAMPLE);
    const reasons = Object.fromEntries(skipped.map((s) => [s.url, s.reason]));

    expect(reasons['https://api.example.com/v1/cached']).toMatch(/browser cache/);
    expect(reasons['wss://api.example.com/socket']).toMatch(/out of scope/);
    expect(reasons['https://api.example.com/v1/aborted']).toMatch(/status is 0/);
  });

  it('always reports that HAR carries no matching rules and no redaction', () => {
    const { notes } = importHarText(SAMPLE);
    expect(notes.some((n) => n.includes('no matching rules'))).toBe(true);
    expect(notes.some((n) => n.includes('HAR performs no redaction'))).toBe(true);
  });

  it('does not redact by itself: that is the caller\'s explicit decision', () => {
    const { fixture } = importHarText(SAMPLE);
    const auth = (fixture.interactions[0]!.request.headers ?? []).find((h) => h[0] === 'authorization');
    expect(auth?.[1]).toContain('Bearer');
    expect(fixture.meta?.redaction?.applied).toBe(false);
  });

  it('rejects a document that is not a HAR', () => {
    expect(() => importHar({})).toThrow(HifStructuralError);
    expect(() => importHar({ log: {} })).toThrow(HifStructuralError);
    expect(() => importHarText('not json')).toThrow(HifStructuralError);
  });

  it('honours the filter option', () => {
    const { fixture } = importHarText(SAMPLE, { filter: '/v1/users/7' });
    expect(fixture.interactions).toHaveLength(1);
  });
});
