import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installReplay } from '@spool/hif/fetch';
import type { ReplayHandle } from '@spool/hif/fetch';
import { WeatherClient } from './src/weather.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, 'fixtures', 'weather.hif.json'), 'utf8');

let spool: ReplayHandle;
let client: WeatherClient;

beforeEach(() => {
  spool = installReplay(FIXTURE);
  // The key is never used against a real service, and was never written to the
  // fixture: the recorder redacted it (spec §9).
  client = new WeatherClient('https://api.weather.example', 'whatever-you-like');
});

afterEach(() => {
  spool.restore();
});

describe('WeatherClient', () => {
  it('reads current conditions', async () => {
    const conditions = await client.current(51.5, -0.13);

    expect(conditions).toEqual({
      tempC: 14.5,
      condition: 'cloudy',
      observedAt: '2026-08-10T09:00:00Z',
    });

    // §5.4: the fixture declares `expect: { called: "once" }`.
    spool.assertComplete();
  });

  it('matches a request whose body changes every run', async () => {
    // `recordedAt` is a fresh timestamp and `requestId` a fresh UUID on every
    // call. The fixture records them as `{{any:iso8601}}` and `{{any:uuid}}`,
    // so it keeps matching without the test having to freeze the clock or
    // inject a UUID factory.
    await client.current(51.5, -0.13);
    await expect(client.submitReading('LHR-01', 14.5)).resolves.toBeUndefined();
  });

  it('handles an upstream timeout', async () => {
    // §10: the fixture raises the error the real transport would raise, so the
    // client's own catch block is what gets exercised.
    await client.current(51.5, -0.13);
    await expect(client.forecastOrNull()).resolves.toBeNull();
  });

  it('explains a request the fixture does not cover', async () => {
    await client.current(51.5, -0.13);

    // Ask for a different city. The api_key is redacted so it matches anything,
    // but lat/lon differ — and the report says exactly that.
    await expect(client.current(48.85, 2.35)).rejects.toThrow(/REQUEST MISMATCH/);

    try {
      await client.current(48.85, 2.35);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('query.value-differs');
      expect(message).toContain('lat');
    }
  });
});
