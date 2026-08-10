# Security policy

## Reporting a vulnerability

Report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/spool-hif/spool/security/advisories/new)
for this repository. Do not open a public issue.

Please include: what you found, how to reproduce it, which implementation and
version, and what you believe the impact is.

You can expect an acknowledgement within 5 working days and an assessment within
15. If a fix is warranted we will agree a disclosure timeline with you; the
default is public disclosure once a fixed release is available, with credit
unless you prefer otherwise.

This project has no bug bounty.

## What counts as a vulnerability here

Spool is a local test-support library with no network listener and no
privileged operation, so the threat model is narrow but not empty.

**In scope:**

- A fixture that causes an implementation to execute code, escape the file
  system, or crash the host process in a way an attacker could exploit. Fixtures
  are often committed to a repository and read from untrusted forks in CI.
- Denial of service from a crafted fixture: unbounded memory, or a regular
  expression that does not terminate. The `{{regex:...}}` subset
  ([§7.6.2](./specification/hif-1.0.md#762-regex)) excludes constructs that
  enable catastrophic backtracking and bounds subject length; a pattern that
  defeats those bounds is a vulnerability.
- **Redaction failing to apply a rule it claims to have applied.** If
  `meta.redaction.rules` lists `headers` but an `authorization` header survived
  verbatim, that is a security bug, not a feature request.
- A recorder writing a credential to disk that its configured rules should have
  caught.
- Path traversal or arbitrary file write from a fixture path or CLI argument.

**Not in scope:**

- **Redaction missing a secret no rule describes.** This is documented, expected
  behaviour, and stated in the specification's normative text: redaction reduces
  exposure, it does not guarantee removal. Entropy detection in particular has
  false negatives by construction. If you have found a *class* of credential our
  default rules should recognise, please open a normal issue — that is a welcome
  contribution, just not a vulnerability report.
- Secrets in a fixture recorded with redaction explicitly disabled.
- Denial of service from a fixture you wrote yourself into your own test suite.
- Vulnerabilities in `httpx`, `requests`, `undici` or any other optional
  dependency — report those upstream.

## Handling recorded traffic safely

The most likely way this project hurts you is not a code vulnerability. It is a
credential committed inside a fixture.

**Please read this before recording against a real system.**

- Redaction runs by default at record time, and covers common credential
  carriers: `authorization`, `cookie`, `set-cookie`, `x-api-key` and others;
  credential-shaped query parameters; credential-named JSON members; and
  optional entropy detection on header and query values. The full default lists
  are in [§9.1](./specification/hif-1.0.md#91-the-default-rule-set).
- **It will miss things.** A session token in a bespoke header, a bearer token
  embedded in a URL path segment, a customer's personal data in a response body
  — none of these are credentials by name or shape, and nothing detects them
  reliably.
- Recording against production captures production data. Prefer a staging
  environment or a dedicated test account.
- Read the fixture before you commit it. `spool inspect` summarises it and
  `spool scan` reports suspicions, but neither replaces reading the diff.
- `spool scan` reporting nothing means no rule matched. It does not mean the
  fixture is clean, and the command says so in its own output.
- If a secret does reach a repository, rotate it. Removing the commit is not
  sufficient.

## Fixtures from untrusted sources

Treat a fixture like any other data file from an untrusted source. The
implementations are written on that assumption: fixtures are parsed, never
evaluated; regular expressions are restricted to a subset and bounded; and no
fixture member is ever used as a file path.

Both implementations distinguish structural errors from match failures
([§11.3](./specification/hif-1.0.md#113-errors)), so a malformed fixture fails
loudly at load time rather than degrading into confusing behaviour later.

## Supported versions

Until 1.0, security fixes land on the latest minor release of each
implementation. After 1.0 this section will state a support window.

| Package | Supported |
| --- | --- |
| `@spool/hif` | latest 0.x |
| `spool-hif` | latest 0.x |
