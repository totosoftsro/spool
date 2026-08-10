# Governance

Spool is a small project. This document is deliberately short, and describes how
things actually work rather than an aspirational structure.

## Roles

**Contributors** are anyone who opens an issue or a pull request. No formal step
is required.

**Maintainers** review and merge pull requests, cut releases, and decide
specification changes. They are listed in [MAINTAINERS.md](./MAINTAINERS.md),
with the areas each one covers.

**Implementation maintainers** own one language implementation. They have merge
rights over their implementation's directory and are expected to keep it passing
conformance. A language port with an active maintainer is listed as supported; a
port without one is listed as unmaintained rather than quietly rotting.

## Becoming a maintainer

Sustained, good-quality contribution over time, and interest in continuing.
There is no contribution quota. An existing maintainer proposes it, and the
proposal carries if no other maintainer objects within a week.

The most common route is contributing a language implementation and then
maintaining it.

## Decisions

Most changes need one maintainer approval and no unresolved objections.

**Changes to the specification** need approval from two maintainers, one of whom
maintains an implementation other than the one that prompted the change. This is
the only place the process is deliberately heavier, for a specific reason: the
value of HIF is that independent implementations agree, and a spec change waved
through by whoever happened to hit the problem is how that erodes.

A specification change must include:

1. The normative text change, with reasoning.
2. Conformance cases covering the new or changed behaviour.
3. Updates to every implementation at the affected conformance level.
4. An entry in `specification/CHANGELOG.md`.

**Disagreements** are resolved by discussion in the pull request or issue. If
that stalls, any maintainer can call for a vote of the maintainer group; a
simple majority decides, and the reasoning is recorded in the thread. This has
not been needed yet.

## Versioning

The specification and the implementations version independently.

**The specification** uses `MAJOR.MINOR`, defined in
[§11](./specification/hif-1.0.md#11-versioning-and-compatibility). Additive,
optional changes increment MINOR. Anything that changes the meaning of an
existing member, removes one, or makes an optional member required increments
MAJOR — and a major bump is a serious event that requires a migration story, not
just a version number.

**Implementations** follow [semantic versioning](https://semver.org/) over their
public API, which is the set of symbols each one documents as public. The
specification version an implementation targets is independent of its own
version: `@spool/hif` 2.0 may still target HIF 1.0.

Implementations state which spec version and conformance level they support, and
the conformance suite verifies the claim. An implementation may not advertise a
level it does not pass.

## Backwards compatibility

The fixture format is the long-lived artifact here. People will have fixtures in
their repositories for years, and the format's job is to still read them.

- A reader must accept any `1.x` fixture, ignoring members it does not know.
- A reader must reject a differing major version outright rather than guessing.
- Removing a fixture feature requires a major version and a documented migration
  path.

Implementation APIs get the ordinary semver treatment: breaking changes are
allowed in a major release, with a deprecation period where practical.

## Releases

Releases are cut by maintainers via a tag, which triggers the publish workflow.
Each release requires a green CI run including the cross-implementation parity
check, and a CHANGELOG entry.

Nothing is published from a maintainer's laptop.

## Scope

What this project is: a portable HTTP fixture format, and high-quality
implementations of it.

What it is not, and what will be declined:

- A mock server product, a service, or anything requiring an account.
- A general HTTP proxy or traffic-analysis tool.
- A contract-testing system. That is a different problem with good existing
  tools; HIF fixtures can feed one, but the negotiation protocol is out of scope.
- Anything that makes the core depend on a network service or telemetry.

Features that only make sense for one language belong in that implementation, or
in a separate package, not in the specification.

## If this project becomes unmaintained

The specification and conformance suite are the durable parts, and are licensed
so that anyone can implement or fork them. If the maintainers become inactive,
the repository should be marked unmaintained in its README rather than left
looking healthy. Forks are welcome and do not need permission.
