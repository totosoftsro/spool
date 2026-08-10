import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  compilePortableRegex,
  decodeQuery,
  digestRequest,
  entropyTokens,
  findLossyNumbers,
  normalizeUrl,
  omitPaths,
  parsePath,
  parsePlaceholder,
  parseTextTemplate,
  redactFixture,
  removeDotSegments,
  scanFixture,
  shannonEntropy,
  textMatchesTemplate,
} from '../src/index.js';
import { HifStructuralError } from '../src/errors.js';
import type { Fixture } from '../src/types.js';

describe('URL normalization (§6.4)', () => {
  it('lowercases scheme and host', () => {
    const u = normalizeUrl('HTTPS://API.Example.COM/Path');
    expect(u.scheme).toBe('https');
    expect(u.host).toBe('api.example.com');
    expect(u.path).toBe('/Path');
  });

  it('removes the default port but keeps others', () => {
    expect(normalizeUrl('https://x:443/a').port).toBeNull();
    expect(normalizeUrl('http://x:80/a').port).toBeNull();
    expect(normalizeUrl('https://x:8443/a').port).toBe(8443);
    expect(normalizeUrl('http://x:443/a').port).toBe(443);
  });

  it('turns an empty path into /', () => {
    expect(normalizeUrl('https://x').path).toBe('/');
    expect(normalizeUrl('https://x?a=1').path).toBe('/');
  });

  it('uppercases percent triplets and decodes unreserved octets', () => {
    // %2f stays encoded (reserved), %7e becomes ~ (unreserved).
    expect(normalizeUrl('https://x/a%2fb%7ec').path).toBe('/a%2Fb~c');
    expect(normalizeUrl('https://x/%41%42').path).toBe('/AB');
  });

  it('resolves dot segments per RFC 3986 §5.2.4', () => {
    expect(removeDotSegments('/a/b/c/./../../g')).toBe('/a/g');
    expect(removeDotSegments('/a/../../b')).toBe('/b');
    expect(normalizeUrl('https://x/a/b/../c').path).toBe('/a/c');
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://x/a?b=1#frag').href).toBe('https://x/a?b=1');
  });

  it('does not sort or rewrite the query', () => {
    expect(normalizeUrl('https://x/a?b=2&a=1').href).toBe('https://x/a?b=2&a=1');
  });

  it('does not add or remove a trailing slash', () => {
    expect(normalizeUrl('https://x/a/').path).toBe('/a/');
    expect(normalizeUrl('https://x/a').path).toBe('/a');
  });

  it('rejects non-http schemes', () => {
    expect(() => normalizeUrl('ftp://x/a')).toThrow(HifStructuralError);
  });
});

describe('query decomposition (§6.4.1)', () => {
  it('splits on the first = only', () => {
    expect(decodeQuery('a=b=c')).toEqual([{ name: 'a', value: 'b=c', valueless: false }]);
  });

  it('distinguishes a valueless parameter from an empty value', () => {
    expect(decodeQuery('flag')).toEqual([{ name: 'flag', value: '', valueless: true }]);
    expect(decodeQuery('flag=')).toEqual([{ name: 'flag', value: '', valueless: false }]);
  });

  it('replaces + with a space, then percent-decodes', () => {
    expect(decodeQuery('q=a+b%20c')).toEqual([{ name: 'q', value: 'a b c', valueless: false }]);
  });

  it('preserves order and repetition', () => {
    expect(decodeQuery('a=1&a=1&b=2').map((p) => p.name)).toEqual(['a', 'a', 'b']);
  });

  it('drops empty segments', () => {
    expect(decodeQuery('a=1&&b=2')).toHaveLength(2);
  });
});

describe('canonical JSON (§12, RFC 8785)', () => {
  it('sorts members by UTF-16 code unit', () => {
    expect(canonicalize({ b: 1, a: 2, A: 3 })).toBe('{"A":3,"a":2,"b":1}');
  });

  it('normalizes numbers per ECMAScript Number::toString', () => {
    expect(canonicalize({ x: 1.0 })).toBe('{"x":1}');
    expect(canonicalize({ x: -0 })).toBe('{"x":0}');
    expect(canonicalize({ x: 1e21 })).toBe('{"x":1e+21}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ x: NaN } as never)).toThrow(TypeError);
  });

  it('detects round-trip loss for large integers (§12.3)', () => {
    const lossy = findLossyNumbers('{"id": 10000000000000001}');
    expect(lossy).toEqual([{ literal: '10000000000000001', canonical: '10000000000000000' }]);
  });

  it('does not flag literals that merely look different', () => {
    expect(findLossyNumbers('{"a": 1.0, "b": 1e2, "c": 0.5}')).toEqual([]);
  });

  it('ignores number-like text inside strings', () => {
    expect(findLossyNumbers('{"id": "10000000000000001"}')).toEqual([]);
  });
});

describe('JSON paths (§7.7)', () => {
  it('parses pointers and wildcards', () => {
    expect(parsePath('/a/*/b')).toEqual([
      { kind: 'literal', value: 'a' },
      { kind: 'wildcard' },
      { kind: 'literal', value: 'b' },
    ]);
  });

  it('unescapes ~0, ~1 and ~2', () => {
    expect(parsePath('/a~1b')).toEqual([{ kind: 'literal', value: 'a/b' }]);
    expect(parsePath('/a~0b')).toEqual([{ kind: 'literal', value: 'a~b' }]);
    expect(parsePath('/~2')).toEqual([{ kind: 'literal', value: '*' }]);
  });

  it('rejects an unknown escape and a relative path', () => {
    expect(() => parsePath('/a~3b')).toThrow(HifStructuralError);
    expect(() => parsePath('a/b')).toThrow(HifStructuralError);
    expect(() => parsePath('')).toThrow(HifStructuralError);
  });

  it('omits wildcard matches from every array element', () => {
    const value = { items: [{ id: 1, t: 'x' }, { id: 2, t: 'y' }] };
    expect(omitPaths(value, ['/items/*/t'])).toEqual({ items: [{ id: 1 }, { id: 2 }] });
  });

  it('treats a path that matches nothing as a no-op', () => {
    expect(omitPaths({ a: 1 }, ['/b/c'])).toEqual({ a: 1 });
  });
});

describe('portable regex subset (§7.6.2)', () => {
  it('compiles allowed constructs and anchors them', () => {
    const re = compilePortableRegex('[a-z]+\\d{2}');
    expect(re.test('abc12')).toBe(true);
    expect(re.test('ABC12')).toBe(false); // anchored and case-sensitive
    expect(re.test('abc123')).toBe(false); // {2} is exact, and the match is anchored
    expect(re.test('abc12x')).toBe(false);
  });

  it('defines \\s over ASCII only, unlike JavaScript', () => {
    const re = compilePortableRegex('a\\sb');
    expect(re.test('a b')).toBe(true);
    // U+00A0 is Unicode whitespace; JS \s would match it, the HIF subset must not.
    expect(re.test('a b')).toBe(false);
  });

  it('makes . exclude only U+000A, unlike JavaScript', () => {
    const re = compilePortableRegex('a.b');
    expect(re.test('a\rb')).toBe(true);
    expect(re.test('a\nb')).toBe(false);
  });

  it('rejects excluded constructs', () => {
    for (const bad of ['(?:a)', 'a(?=b)', '(a)\\1', '\\bword', 'a*?', 'a++', '[\\D]', '\\p{L}']) {
      expect(() => compilePortableRegex(bad), bad).toThrow(HifStructuralError);
    }
  });

  it('allows an escaped literal that a naive pre-scan would reject as lazy', () => {
    const re = compilePortableRegex('a\\??');
    expect(re.test('a?')).toBe(true);
    expect(re.test('a')).toBe(true);
  });

  it('rejects malformed patterns', () => {
    for (const bad of ['[abc', 'a)', '(a', 'a{', '*a', 'a\\']) {
      expect(() => compilePortableRegex(bad), bad).toThrow(HifStructuralError);
    }
  });
});

describe('placeholders (§7.6)', () => {
  it('recognises only whole-string placeholders', () => {
    expect(parsePlaceholder('{{any}}')).toEqual({ kind: 'any' });
    expect(parsePlaceholder('x {{any}} y')).toBeNull();
    expect(parsePlaceholder('{{nope}}')).toBeNull();
  });

  it('honours the leading-backslash escape (§7.6.1)', () => {
    expect(parsePlaceholder('\\{{any}}')).toBeNull();
  });

  it('matches text templates leftmost-shortest and anchored', () => {
    const t = parseTextTemplate('id=<{{any}}> ok');
    expect(textMatchesTemplate(t, 'id=<abc> ok')).toBe(true);
    expect(textMatchesTemplate(t, 'id=<abc> ok!')).toBe(false);
    expect(textMatchesTemplate(t, 'xid=<abc> ok')).toBe(false);
  });

  it('degenerates to string equality with no placeholders', () => {
    const t = parseTextTemplate('plain text');
    expect(textMatchesTemplate(t, 'plain text')).toBe(true);
    expect(textMatchesTemplate(t, 'plain text ')).toBe(false);
  });

  it('applies the placeholder constraint to the gap contents', () => {
    const t = parseTextTemplate('n={{any:number}};');
    expect(textMatchesTemplate(t, 'n=42;')).toBe(true);
    expect(textMatchesTemplate(t, 'n=abc;')).toBe(false);
  });
});

describe('entropy detection (§9.4)', () => {
  it('computes Shannon entropy in bits per character', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBeCloseTo(2, 10);
    expect(shannonEntropy('')).toBe(0);
  });

  const cfg = { headersAndQuery: true, textBodies: true, minLength: 24, maxLength: 512, minBits: 3.5 };

  it('flags a high-entropy credential-shaped token', () => {
    expect(entropyTokens('Bearer aB3xY9zQ7mN2pL5kR8sT4vW6', cfg)).toEqual(['aB3xY9zQ7mN2pL5kR8sT4vW6']);
  });

  it('ignores tokens that are too short, all-letters, or all-digits', () => {
    expect(entropyTokens('short', cfg)).toEqual([]);
    expect(entropyTokens('abcdefghijklmnopqrstuvwxyz', cfg)).toEqual([]);
    expect(entropyTokens('123456789012345678901234567890', cfg)).toEqual([]);
  });
});

describe('redaction (§9)', () => {
  const fixture: Fixture = {
    hif: '1.0',
    interactions: [
      {
        request: {
          method: 'POST',
          url: 'https://api.example.com/v1/login?api_key=abc123&page=2',
          headers: [
            ['authorization', 'Bearer sk-live-9f8e7d6c5b4a3210'],
            ['content-type', 'application/json'],
          ],
          body: { encoding: 'json', json: { user: 'ada', password: 'hunter2', keep: 1 } },
        },
        response: {
          status: 200,
          headers: [['set-cookie', 'session=abc']],
          body: { encoding: 'json', json: { access_token: 'xyz', ok: true } },
        },
      },
    ],
  };

  it('redacts default headers, query parameters and JSON fields', () => {
    const { value, rules } = redactFixture(fixture);
    const req = value.interactions[0]!.request;
    expect(req.headers![0]).toEqual(['authorization', '{{redacted}}']);
    expect(req.headers![1]).toEqual(['content-type', 'application/json']);
    expect(req.url).toContain('api_key=%7B%7Bredacted%7D%7D');
    expect(req.url).toContain('page=2');
    expect((req.body as { json: Record<string, unknown> }).json).toEqual({
      user: 'ada',
      password: '{{redacted}}',
      keep: 1,
    });
    expect(value.interactions[0]!.response!.headers![0]).toEqual(['set-cookie', '{{redacted}}']);
    expect(rules).toEqual(['headers', 'jsonFields', 'queryParams']);
  });

  it('marks a modified body and records applied rules in meta (§9.5, §9.6)', () => {
    const { value } = redactFixture(fixture);
    expect((value.interactions[0]!.request.body as { redacted?: boolean }).redacted).toBe(true);
    expect(value.meta?.redaction?.applied).toBe(true);
  });

  it('leaves an already-redacted fixture alone on a second pass', () => {
    const once = redactFixture(fixture).value;
    const twice = redactFixture(once).value;
    expect(JSON.stringify(twice.interactions)).toBe(JSON.stringify(once.interactions));
  });

  it('scan reports suspicions and finds nothing in a redacted fixture', () => {
    expect(scanFixture(fixture).length).toBeGreaterThan(0);
    expect(scanFixture(redactFixture(fixture).value)).toEqual([]);
  });
});

describe('digest (§14)', () => {
  it('is stable across equivalent URLs', () => {
    const a = digestRequest({ method: 'GET', url: 'https://API.example.com:443/a?y=2&x=1' });
    const b = digestRequest({ method: 'GET', url: 'https://api.example.com/a?x=1&y=2' });
    expect(a).toBe(b);
  });

  it('changes when the body changes', () => {
    const a = digestRequest({ method: 'POST', url: 'https://x/a', body: { encoding: 'json', json: { a: 1 } } });
    const b = digestRequest({ method: 'POST', url: 'https://x/a', body: { encoding: 'json', json: { a: 2 } } });
    expect(a).not.toBe(b);
  });

  it('is insensitive to header order but not to header content', () => {
    const a = digestRequest({ method: 'GET', url: 'https://x/a', headers: [['b', '2'], ['a', '1']] });
    const b = digestRequest({ method: 'GET', url: 'https://x/a', headers: [['a', '1'], ['b', '2']] });
    const c = digestRequest({ method: 'GET', url: 'https://x/a', headers: [['a', '9'], ['b', '2']] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('produces a 64-character lowercase hex string', () => {
    expect(digestRequest({ method: 'GET', url: 'https://x/' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
