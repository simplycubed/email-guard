# Changelog

All notable changes to this package are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versions follow semver, with an
honest `0.x` while the API settles.

A breaking change ships with a `### Migration` block giving the old call, the new call, and any
config change.

## [Unreleased]

### Changed

- Dev-only: the build compiler is now TypeScript 7.0.2, installed side by side with the TypeScript
  6 API that typescript-eslint needs. `tsc` is TS 7, the `typescript` module resolves to TS 6, and
  `tsc6` is available for comparison. No runtime dependency, no public API change, and the emitted
  declarations are byte-identical to those TypeScript 5.9.3 produced, verified by diffing against
  the published 0.1.1 tarball. A consumer typechecks cleanly on TypeScript 5.9.3, 6.0.3 and 7.0.2
  with `skipLibCheck` off, so no consumer needs to pin anything.

## [0.1.1] - 2026-11-21

One library fix, below, with no API or behaviour change: `normalizeAddress` returns exactly what it
returned in 0.1.0 for every input, so there is no migration.

This is also the first version published by the tag-triggered, Environment-gated workflow, and so
the first carrying a signed build attestation tying the tarball to the run that produced it.
0.0.0-stage and 0.1.0 were both published by hand and have no provenance.

### Security

- `normalizeAddress` no longer uses a polynomial-time regular expression to strip trailing dots
  from the domain, closing a denial-of-service path (CodeQL `js/polynomial-redos`). The old
  `/\.+$/` matched the dot run from every start offset, failed its end anchor, and backtracked
  the whole run, so the cost was quadratic in input length: `a@` + `.`*n + `x` measured 28ms at
  n=8000 and 1.8s at n=64000. `normalizeAddress` is exported, takes whatever the consumer passes,
  and imposes no length cap of its own (the 254-character limit in the internal mailbox guard
  applies to its output), so a few kilobytes of untrusted input could exhaust a Cloudflare
  Workers CPU budget. It is now a single backward scan. Behaviour is unchanged, confirmed by
  differential testing the old and new implementations over 200,000 generated inputs, and the
  regression test fails at 1784ms against the old code.
- Dev-dependency updates closing three moderate advisories, none of which reach a consumer: the
  package has no runtime dependencies and ships only `dist/` and `src/`.
  - `vitest` and `@vitest/coverage-v8` to 4.1.12, which brings `@vitest/mocker` to 4.1.12 —
    GHSA-qxg6-89mg-rqv8 (code injection via unauthenticated manual mock registration) and
    GHSA-xp26-3454-mjgp (Windows backslash traversal bypassing the mocker redirect allowlist).
  - `typescript-eslint` floor raised to ^8.73.0, whose `@typescript-eslint/typescript-estree`
    depends on `minimatch` ^11.0.1 rather than ^10.2.2 — GHSA-g3hv-75wg-m249 (denial of service
    via globparts amplification, affecting >=7.0.0 <11.0.1).

### Changed

- `publish.yml` no longer restores a pnpm cache in the `verify` job. `verify` is the job that runs
  the gate and produces the `dist/` that gets published, and a tag run's cache scope falls back to
  the default branch — so a cache written by any `main` run was an input to the published bytes.
  The `publish` job already refused the cache for the same reason. The release path now installs
  from the lockfile, cold, in both jobs.
- Dependabot intake: majors arrive as individual PRs, version-locked families move as a unit, and
  published versions age behind a cooldown before they can reach a PR branch.

### Added

- CodeQL static analysis over both the library and the workflow files.

## [0.1.0] - 2026-10-25

Published by hand, with no provenance attestation. Superseded by 0.1.1 for that reason alone; the
code is the same.

### Security

- Token MACs must be canonical base64url; `signToken` and `suppress` refuse addresses that contain
  whitespace, control or zero-width characters.
- `normalizeAddress` drops a trailing domain dot, so `a@example.com.` matches a suppression entry.
- `canSendMarketing` fails closed: `suppressed` is required and anything but `false` denies;
  non-finite send timestamps count as sent now; caps must be integers of at least 1.
- Throttle ids are limited to 512 characters, a store's fresh counter is trusted regardless of clock
  skew, and an invalid counter throws.
- `createDohResolver` accepts https endpoints only, builds the query with `URL`, and bounds the
  answers it reads. `isDisposableDomain` returns false for names over 253 characters.
- The leak scan now also covers `AGENTS.md`, `CHANGELOG.md`, `docs/` and `.github/`.

### Added

- `checkAddress`: syntax, typo suggestion, disposable-domain, role-address and MX checks, with a
  default DNS-over-HTTPS resolver (`createDohResolver`) that works on Workers.
- `signToken` and `verifyToken`: stateless HMAC-SHA256 tokens on Web Crypto, with purpose binding,
  expiry, clock-skew tolerance and key rotation.
- `canSendMarketing`: a pure send decision with a 1-per-24-hours and 12-per-30-days default cap.
- `createThrottle`: named fixed-window rules over a consumer-supplied `ThrottleStore`.
- `suppress` and `isSuppressed` over a consumer-supplied `SuppressionStore`.
- `normalizeAddress`: the one shared normalizer (trim and lowercase only).
- `./testing` subpath: in-memory throttle and suppression stores and a fake DNS resolver.
- `scripts/no-leaks.mjs`: the publish-safety scan, with a negative-control test.
- Tag-triggered, Environment-gated publish workflow with provenance.
