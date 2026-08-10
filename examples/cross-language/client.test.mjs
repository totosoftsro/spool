/**
 * Replay the shared fixture from Node.
 *
 * Its Python twin is `test_client.py` in this directory. Both read the same
 * `fixtures/github-user.hif.json` and assert the same behaviour.
 *
 * Run with:  node --test client.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { installReplay } from '@spool/hif/fetch';
import { HifMatchError } from '@spool/hif';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, 'fixtures', 'github-user.hif.json'), 'utf8');

const HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'spool-example/1.0',
};

let spool;

beforeEach(() => {
  spool = installReplay(FIXTURE);
});

afterEach(() => {
  spool.restore();
});

test('fetches a user', async () => {
  const response = await fetch('https://api.github.com/users/octocat', { headers: HEADERS });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).login, 'octocat');
  assert.equal(response.headers.get('x-ratelimit-remaining'), '59');

  spool.assertComplete();
});

test('handles a 404', async () => {
  await fetch('https://api.github.com/users/octocat', { headers: HEADERS });

  const response = await fetch('https://api.github.com/users/this-user-does-not-exist-000', {
    headers: HEADERS,
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).message, 'Not Found');

  spool.assertComplete();
});

test('retries after a rate limit', async () => {
  // Two interactions share the same recorded request. Spec §7.5 selects them in
  // document order, so the first call gets the 403 and the second gets the 200.
  // No sequencing API is involved.
  await fetch('https://api.github.com/users/octocat', { headers: HEADERS });

  const first = await fetch('https://api.github.com/users/octocat/repos', { headers: HEADERS });
  assert.equal(first.status, 403);
  assert.equal(first.headers.get('retry-after'), '1');

  const second = await fetch('https://api.github.com/users/octocat/repos', { headers: HEADERS });
  assert.equal(second.status, 200);
  assert.deepEqual(
    (await second.json()).map((repo) => repo.name),
    ['Hello-World', 'Spoon-Knife'],
  );

  spool.assertComplete();
});

test('an unrecorded request fails loudly and offline', async () => {
  await fetch('https://api.github.com/users/octocat', { headers: HEADERS });

  await assert.rejects(
    () => fetch('https://api.github.com/users/someone-else', { headers: HEADERS }),
    (error) => {
      assert.ok(error instanceof HifMatchError);
      assert.match(error.message, /REQUEST MISMATCH/);
      // The report names the closest recorded interaction rather than just failing.
      assert.match(error.message, /Closest candidate/);
      return true;
    },
  );

  spool.assertComplete();
});
