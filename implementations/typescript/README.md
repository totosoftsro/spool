# @spool/hif

Record and replay HTTP traffic using the portable [HIF](../../specification/hif-1.0.md)
fixture format. Deterministic matching, explained mismatches, redaction on by
default.

```bash
npm install --save-dev @spool/hif
```

- Node 18.17+, Deno, Bun
- **Zero runtime dependencies**
- Conformance level: **Full** (HIF 1.0)

## Replay

```ts
import { installReplay } from '@spool/hif/fetch';
import { readFileSync } from 'node:fs';

const spool = installReplay(readFileSync('fixtures/users.hif.json', 'utf8'));
try {
  const response = await fetch('https://api.example.com/users/7');
  console.log(await response.json());
  spool.assertComplete();     // every `expect` in the fixture held
} finally {
  spool.restore();
}
```

## Record

```ts
import { installRecord } from '@spool/hif/fetch';
import { writeFileSync } from 'node:fs';

const spool = installRecord({ name: 'users-api' });
try {
  await exerciseYourCode();
} finally {
  writeFileSync('fixtures/users.hif.json', spool.toJSON());
  console.error(spool.redactionSummary());  // never claims the fixture is safe
  spool.restore();
}
```

## Adapter coverage

The `fetch` adapter replaces `globalThis.fetch`, which covers anything built on
global fetch.

It does **not** cover clients that use Node's `http`/`https` modules directly —
axios on Node, node-fetch v2, got, superagent. An adapter for those is the
project's most-wanted contribution; see
[docs/contributing-adapters.md](../../docs/contributing-adapters.md).

## Public API

Everything exported from `@spool/hif` is public and follows semantic versioning.

| Area | Exports |
| --- | --- |
| Replay | `Player`, `deliverable`, `faultError` |
| Record | `Recorder` |
| Fixtures | `parseFixture`, `validateFixture`, `serializeFixture`, `resolveMatchConfig` |
| Matching | `normalizeRequest`, `matchRequest`, `isMatch` |
| Explanation | `explain`, `renderMismatch`, `renderRequest` |
| Redaction | `redactFixture`, `scanFixture`, `entropyTokens`, `shannonEntropy`, `REDACTED`, defaults |
| Primitives | `canonicalize`, `digestRequest`, `normalizeUrl`, `compilePortableRegex`, JSON-path helpers |
| Errors | `HifStructuralError`, `HifMatchError`, `HifExpectationError`, `HifFaultError` |

Anything not exported from the package root is internal.

## CLI

```bash
npx spool lint fixtures/*.hif.json
npx spool explain fixtures/users.hif.json request.json
```

Full reference: [docs/cli.md](../../docs/cli.md).

## Development

```bash
npm ci
npm run typecheck
npm test          # unit tests plus the shared conformance suite
npm run build
```

`npm run conformance` runs only the shared suite from `../../conformance`.
