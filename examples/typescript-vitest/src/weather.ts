/**
 * The code under test.
 *
 * Note that it knows nothing about Spool. That is the point: a fixture replaces
 * the network, not your architecture. There is no injected client, no
 * test-only branch, and no interface extracted purely to enable mocking.
 */

export interface Conditions {
  tempC: number;
  condition: string;
  observedAt: string;
}

export class WeatherClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async current(lat: number, lon: number): Promise<Conditions> {
    const url = new URL(`${this.baseUrl}/v1/current`);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Weather lookup failed: ${response.status}`);
    return (await response.json()) as Conditions;
  }

  async submitReading(stationId: string, tempC: number): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/readings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stationId,
        tempC,
        // Two values that change on every run. Without placeholders, a fixture
        // recorded today would never match tomorrow's request.
        recordedAt: new Date().toISOString(),
        requestId: crypto.randomUUID(),
      }),
    });
    if (response.status !== 202) throw new Error(`Reading rejected: ${response.status}`);
  }

  /** Returns null when the upstream provider is unreachable. */
  async forecastOrNull(): Promise<unknown | null> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/forecast`);
      return await response.json();
    } catch {
      return null;
    }
  }
}
