import { describe, expect, it } from 'vitest';
import { Player, deliverable, isMatch, matchRequest, normalizeRequest, resolveMatchConfig } from '../src/index.js';
import { HifExpectationError, HifMatchError, HifStructuralError } from '../src/errors.js';
import { parseFixture } from '../src/fixture.js';
import { renderMismatch } from '../src/render.js';
import type { Fixture, HifRequest, MatchConfig } from '../src/types.js';

function match(recorded: HifRequest, live: HifRequest, cfg?: MatchConfig): boolean {
  return isMatch(matchRequest(normalizeRequest(recorded), normalizeRequest(live), resolveMatchConfig(undefined, cfg)));
}

describe('scalar matching (§7.1)', () => {
  const base: HifRequest = { method: 'GET', url: 'https://api.example.com/v1/users' };

  it('matches an identical request', () => {
    expect(match(base, base)).toBe(true);
  });

  it('treats an explicit default port as equal', () => {
    expect(match(base, { method: 'GET', url: 'https://api.example.com:443/v1/users' })).toBe(true);
  });

  it('rejects a different method, host or path', () => {
    expect(match(base, { ...base, method: 'POST' })).toBe(false);
    expect(match(base, { ...base, url: 'https://other.example.com/v1/users' })).toBe(false);
    expect(match(base, { ...base, url: 'https://api.example.com/v1/other' })).toBe(false);
  });

  it('honours ignore', () => {
    expect(match(base, { ...base, method: 'POST' }, { method: 'ignore' })).toBe(true);
    expect(match(base, { ...base, url: 'https://other.example.com/v1/users' }, { host: 'ignore' })).toBe(true);
  });
});

describe('query matching (§7.3)', () => {
  const rec: HifRequest = { method: 'GET', url: 'https://x/a?b=2&a=1' };

  it('is order-insensitive but repetition-sensitive', () => {
    expect(match(rec, { method: 'GET', url: 'https://x/a?a=1&b=2' })).toBe(true);
    expect(match({ method: 'GET', url: 'https://x/a?a=1&a=1' }, { method: 'GET', url: 'https://x/a?a=1' })).toBe(false);
  });

  it('rejects extra parameters in exact mode and accepts them in subset mode', () => {
    const live: HifRequest = { method: 'GET', url: 'https://x/a?a=1&b=2&c=3' };
    expect(match(rec, live)).toBe(false);
    expect(match(rec, live, { query: { mode: 'subset' } })).toBe(true);
  });

  it('drops ignored names from both sides', () => {
    const live: HifRequest = { method: 'GET', url: 'https://x/a?a=1&b=2&ts=999' };
    expect(match(rec, live, { query: { ignore: ['ts'] } })).toBe(true);
  });

  it('distinguishes valueless from empty', () => {
    expect(match({ method: 'GET', url: 'https://x/a?f' }, { method: 'GET', url: 'https://x/a?f=' })).toBe(false);
  });

  it('honours a placeholder in a recorded query value', () => {
    const withPh: HifRequest = { method: 'GET', url: 'https://x/a?nonce=%7B%7Bany%7D%7D' };
    expect(match(withPh, { method: 'GET', url: 'https://x/a?nonce=whatever' })).toBe(true);
  });
});

describe('header matching (§7.2)', () => {
  const rec: HifRequest = {
    method: 'GET',
    url: 'https://x/a',
    headers: [
      ['content-type', 'application/json'],
      ['x-trace', 'abc'],
    ],
  };

  it('ignores headers by default', () => {
    expect(match(rec, { method: 'GET', url: 'https://x/a' })).toBe(true);
  });

  it('compares only listed names in listed mode', () => {
    const cfg: MatchConfig = { headers: { mode: 'listed', include: ['content-type'] } };
    expect(match(rec, { method: 'GET', url: 'https://x/a', headers: [['content-type', 'application/json']] }, cfg)).toBe(true);
    expect(match(rec, { method: 'GET', url: 'https://x/a', headers: [['content-type', 'text/plain']] }, cfg)).toBe(false);
  });

  it('allows extra live headers in all mode but requires the recorded ones', () => {
    const cfg: MatchConfig = { headers: { mode: 'all' } };
    const withExtra: HifRequest = {
      method: 'GET',
      url: 'https://x/a',
      headers: [
        ['content-type', 'application/json'],
        ['x-trace', 'abc'],
        ['user-agent', 'anything'],
      ],
    };
    expect(match(rec, withExtra, cfg)).toBe(true);
    expect(match(rec, { method: 'GET', url: 'https://x/a', headers: [['content-type', 'application/json']] }, cfg)).toBe(false);
  });

  it('compares repeated field values as an ordered list', () => {
    const cfg: MatchConfig = { headers: { mode: 'all' } };
    const a: HifRequest = { method: 'GET', url: 'https://x/a', headers: [['x', '1'], ['x', '2']] };
    const b: HifRequest = { method: 'GET', url: 'https://x/a', headers: [['x', '2'], ['x', '1']] };
    expect(match(a, a, cfg)).toBe(true);
    expect(match(a, b, cfg)).toBe(false);
  });

  it('is case-insensitive on names and strips OWS from values', () => {
    const cfg: MatchConfig = { headers: { mode: 'all' } };
    expect(match(rec, { method: 'GET', url: 'https://x/a', headers: [['Content-Type', ' application/json '], ['X-Trace', 'abc']] }, cfg)).toBe(true);
  });
});

describe('body matching (§7.4)', () => {
  const rec: HifRequest = {
    method: 'POST',
    url: 'https://x/a',
    body: { encoding: 'json', json: { name: 'Ada', email: 'ada@example.com' } },
  };

  it('compares JSON structurally, ignoring member order', () => {
    expect(
      match(rec, { method: 'POST', url: 'https://x/a', body: { encoding: 'json', json: { email: 'ada@example.com', name: 'Ada' } } }),
    ).toBe(true);
  });

  it('rejects an unexpected member by default and allows it with extra: allow', () => {
    const live: HifRequest = {
      method: 'POST',
      url: 'https://x/a',
      body: { encoding: 'json', json: { name: 'Ada', email: 'ada@example.com', role: 'admin' } },
    };
    expect(match(rec, live)).toBe(false);
    expect(match(rec, live, { body: { json: { extra: 'allow' } } })).toBe(true);
  });

  it('always rejects a missing member', () => {
    const live: HifRequest = { method: 'POST', url: 'https://x/a', body: { encoding: 'json', json: { name: 'Ada' } } };
    expect(match(rec, live)).toBe(false);
    expect(match(rec, live, { body: { json: { extra: 'allow' } } })).toBe(false);
  });

  it('is order-sensitive for arrays', () => {
    const a: HifRequest = { method: 'POST', url: 'https://x/a', body: { encoding: 'json', json: { xs: [1, 2] } } };
    const b: HifRequest = { method: 'POST', url: 'https://x/a', body: { encoding: 'json', json: { xs: [2, 1] } } };
    expect(match(a, b)).toBe(false);
  });

  it('treats numbers by canonical value', () => {
    const a: HifRequest = { method: 'POST', url: 'https://x/a', body: { encoding: 'json', json: { n: 1 } } };
    const b: HifRequest = { method: 'POST', url: 'https://x/a', body: { encoding: 'json', json: { n: 1.0 } } };
    expect(match(a, b)).toBe(true);
  });

  it('honours json.ignore paths', () => {
    const a: HifRequest = { method: 'POST', url: 'https://x/a', body: { encoding: 'json', json: { n: 1, ts: 'old' } } };
    const b: HifRequest = { method: 'POST', url: 'https://x/a', body: { encoding: 'json', json: { n: 1, ts: 'new' } } };
    expect(match(a, b, { body: { json: { ignore: ['/ts'] } } })).toBe(true);
  });

  it('satisfies placeholders in a JSON body', () => {
    const withPh: HifRequest = {
      method: 'POST',
      url: 'https://x/a',
      body: { encoding: 'json', json: { id: '{{any:uuid}}', n: '{{any:number}}' } },
    };
    expect(
      match(withPh, {
        method: 'POST',
        url: 'https://x/a',
        body: { encoding: 'json', json: { id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', n: 7 } },
      }),
    ).toBe(true);
    expect(
      match(withPh, {
        method: 'POST',
        url: 'https://x/a',
        body: { encoding: 'json', json: { id: 'not-a-uuid', n: 7 } },
      }),
    ).toBe(false);
  });

  it('compares binary bodies byte-for-byte', () => {
    const a: HifRequest = { method: 'POST', url: 'https://x/a', body: { encoding: 'base64', base64: '3q2+7w==' } };
    const b: HifRequest = { method: 'POST', url: 'https://x/a', body: { encoding: 'base64', base64: '3q2+7g==' } };
    expect(match(a, a)).toBe(true);
    expect(match(a, b)).toBe(false);
  });

  it('treats an absent body and an empty body as identical (§6.5)', () => {
    expect(match({ method: 'GET', url: 'https://x/a' }, { method: 'GET', url: 'https://x/a', body: { encoding: 'empty' } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------

const retryFixture: Fixture = {
  hif: '1.0',
  interactions: [
    { id: 'first-fails', request: { method: 'GET', url: 'https://x/job' }, fault: { type: 'connection-reset' } },
    {
      id: 'then-pending',
      request: { method: 'GET', url: 'https://x/job' },
      response: { status: 200, body: { encoding: 'json', json: { state: 'pending' } } },
    },
    {
      id: 'then-done',
      request: { method: 'GET', url: 'https://x/job' },
      response: { status: 200, body: { encoding: 'json', json: { state: 'done' } } },
      replay: { times: 'unlimited' },
    },
  ],
};

describe('selection (§7.5)', () => {
  it('plays identical requests in document order', () => {
    const player = new Player(retryFixture);
    const req: HifRequest = { method: 'GET', url: 'https://x/job' };
    expect(player.select(req).ref).toBe('first-fails');
    expect(player.select(req).ref).toBe('then-pending');
    expect(player.select(req).ref).toBe('then-done');
    expect(player.select(req).ref).toBe('then-done'); // unlimited
  });

  it('resets play counts', () => {
    const player = new Player(retryFixture);
    const req: HifRequest = { method: 'GET', url: 'https://x/job' };
    player.select(req);
    player.reset();
    expect(player.select(req).ref).toBe('first-fails');
  });

  it('reports depletion as the cause when a fixture runs out', () => {
    const fixture: Fixture = {
      hif: '1.0',
      interactions: [{ id: 'only-once', request: { method: 'GET', url: 'https://x/a' }, response: { status: 200 } }],
    };
    const player = new Player(fixture);
    player.select({ method: 'GET', url: 'https://x/a' });

    let error: HifMatchError | undefined;
    try {
      player.select({ method: 'GET', url: 'https://x/a' });
    } catch (err) {
      error = err as HifMatchError;
    }

    expect(error).toBeInstanceOf(HifMatchError);
    expect(error!.report.candidates[0]!.depleted).toBe(true);
    expect(error!.message).toContain('already played 1 of 1 times');
    // §13.4: a depleted candidate has no configuration fix, so nothing is suggested.
    expect(error!.report.suggestions).toEqual([]);
  });

  it('never performs a live request', () => {
    const player = new Player({ hif: '1.0', interactions: [] });
    expect(() => player.select({ method: 'GET', url: 'https://x/a' })).toThrow(HifMatchError);
  });
});

describe('expectations (§5.4)', () => {
  const fixture: Fixture = {
    hif: '1.0',
    interactions: [
      { id: 'must-call', request: { method: 'GET', url: 'https://x/a' }, response: { status: 200 }, expect: { called: 'once' } },
      { id: 'must-not', request: { method: 'GET', url: 'https://x/b' }, response: { status: 200 }, expect: { called: 'never' } },
    ],
  };

  it('passes when expectations are met', () => {
    const player = new Player(fixture);
    player.select({ method: 'GET', url: 'https://x/a' });
    expect(() => player.assertComplete()).not.toThrow();
  });

  it('lists every unmet expectation at once', () => {
    const player = new Player(fixture);
    player.select({ method: 'GET', url: 'https://x/b' });
    try {
      player.assertComplete();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HifExpectationError);
      expect((err as HifExpectationError).failures).toHaveLength(2);
    }
  });

  it('reports unused interactions', () => {
    const player = new Player(fixture);
    expect(player.unusedInteractions()).toEqual(['must-call', 'must-not']);
  });
});

describe('response delivery (§8.1)', () => {
  it('recomputes content-length and drops encoding headers', () => {
    const out = deliverable({
      status: 200,
      headers: [
        ['content-length', '999'],
        ['content-encoding', 'gzip'],
        ['transfer-encoding', 'chunked'],
        ['content-type', 'text/plain'],
      ],
      body: { encoding: 'text', text: 'hello' },
    });
    expect(out.headers).toEqual([
      ['content-type', 'text/plain'],
      ['content-length', '5'],
    ]);
    expect(new TextDecoder().decode(out.body)).toBe('hello');
  });

  it('truncates for partial-response', () => {
    const out = deliverable({ status: 200, body: { encoding: 'text', text: '0123456789' } }, true);
    expect(out.body.length).toBe(5);
  });
});

describe('structural errors (§11.3)', () => {
  const bad: Array<[string, string]> = [
    ['missing hif', '{"interactions":[]}'],
    ['wrong major version', '{"hif":"2.0","interactions":[]}'],
    ['malformed version', '{"hif":"1","interactions":[]}'],
    ['missing interactions', '{"hif":"1.0"}'],
    ['no response or fault', '{"hif":"1.0","interactions":[{"request":{"method":"GET","url":"https://x/"}}]}'],
    [
      'both response and non-partial fault',
      '{"hif":"1.0","interactions":[{"request":{"method":"GET","url":"https://x/"},"response":{"status":200},"fault":{"type":"timeout"}}]}',
    ],
    [
      'duplicate id',
      '{"hif":"1.0","interactions":[{"id":"a","request":{"method":"GET","url":"https://x/"},"response":{"status":200}},{"id":"a","request":{"method":"GET","url":"https://x/"},"response":{"status":200}}]}',
    ],
    [
      'invalid base64',
      '{"hif":"1.0","interactions":[{"request":{"method":"GET","url":"https://x/","body":{"encoding":"base64","base64":"!!!"}},"response":{"status":200}}]}',
    ],
    [
      'status out of range',
      '{"hif":"1.0","interactions":[{"request":{"method":"GET","url":"https://x/"},"response":{"status":99}}]}',
    ],
    [
      'regex outside the subset',
      '{"hif":"1.0","interactions":[{"request":{"method":"GET","url":"https://x/","body":{"encoding":"json","json":{"a":"{{regex:(?:x)}}"}}},"response":{"status":200}}]}',
    ],
  ];

  for (const [name, doc] of bad) {
    it(`rejects: ${name}`, () => {
      expect(() => parseFixture(doc)).toThrow(HifStructuralError);
    });
  }

  it('accepts a forward minor version with a warning (§11.2)', () => {
    const { warnings } = parseFixture('{"hif":"1.7","interactions":[]}');
    expect(warnings.some((w) => w.includes('1.7'))).toBe(true);
  });

  it('warns rather than fails on an unknown member (§2.1)', () => {
    const { warnings } = parseFixture(
      '{"hif":"1.0","interactions":[{"request":{"method":"GET","url":"https://x/"},"response":{"status":200},"match":{"quary":{}}}]}',
    );
    expect(warnings.some((w) => w.includes('quary'))).toBe(true);
  });

  it('warns about a lowercase known method (§6.1)', () => {
    const { warnings } = parseFixture(
      '{"hif":"1.0","interactions":[{"request":{"method":"get","url":"https://x/"},"response":{"status":200}}]}',
    );
    expect(warnings.some((w) => w.includes('lowercase'))).toBe(true);
  });
});

describe('mismatch explanation (§13)', () => {
  const fixture: Fixture = {
    hif: '1.0',
    interactions: [
      {
        id: 'unrelated',
        request: { method: 'GET', url: 'https://x/other' },
        response: { status: 200 },
      },
      {
        id: 'create-user',
        request: {
          method: 'POST',
          url: 'https://api.example.com/api/users',
          headers: [['content-type', 'application/json']],
          body: { encoding: 'json', json: { email: '{{any:string}}', name: 'John' } },
        },
        response: { status: 201 },
      },
    ],
  };

  const live: HifRequest = {
    method: 'POST',
    url: 'https://api.example.com/api/users',
    headers: [['content-type', 'application/json']],
    body: { encoding: 'json', json: { email: 'john@example.com', name: 'John', role: 'admin' } },
  };

  it('ranks the closest candidate first, deterministically', () => {
    const player = new Player(fixture);
    const report = player.explainRequest(live);
    expect(report.candidates[0]!.ref).toBe('create-user');
    expect(report.candidates[0]!.score).toBeGreaterThan(report.candidates[1]!.score);
  });

  it('identifies the unexpected member by path', () => {
    const report = new Player(fixture).explainRequest(live);
    const body = report.candidates[0]!.fields.find((f) => f.field === 'body')!;
    const detail = (body.details ?? [body]).find((d) => d.reason === 'json.unexpected-member');
    expect(detail?.path).toBe('/role');
    expect(detail?.actual).toBe('admin');
  });

  it('emits only verified suggestions (§13.4)', () => {
    const report = new Player(fixture).explainRequest(live);
    expect(report.suggestions.length).toBeGreaterThan(0);
    expect(report.suggestions[0]).toMatchObject({
      target: 'interactions[1].match.body.json.extra',
      value: 'allow',
      verified: true,
    });

    // The claim is checkable: applying the suggestion must make it match.
    expect(match(fixture.interactions[1]!.request, live, { body: { json: { extra: 'allow' } } })).toBe(true);
  });

  it('offers nothing when no single change explains the mismatch', () => {
    const twoProblems: HifRequest = {
      method: 'PUT',
      url: 'https://api.example.com/api/other',
      body: { encoding: 'json', json: { totally: 'different' } },
    };
    const report = new Player(fixture).explainRequest(twoProblems);
    expect(report.suggestions).toEqual([]);
    expect(renderMismatch(report)).toContain('No single configuration change');
  });

  it('renders a report that shows what matched as well as what did not', () => {
    const text = renderMismatch(new Player(fixture).explainRequest(live));
    expect(text).toContain('REQUEST MISMATCH');
    expect(text).toContain('✓ method');
    expect(text).toContain('✗ body');
    expect(text).toContain('/role');
    expect(text).toContain('Suggested action');
  });

  it('is deterministic across repeated runs', () => {
    const a = renderMismatch(new Player(fixture).explainRequest(live));
    const b = renderMismatch(new Player(fixture).explainRequest(live));
    expect(a).toBe(b);
  });

  it('says so when the fixture is empty', () => {
    const report = new Player({ hif: '1.0', interactions: [] }).explainRequest(live);
    expect(report.empty).toBe(true);
    expect(renderMismatch(report)).toContain('no interactions');
  });
});
