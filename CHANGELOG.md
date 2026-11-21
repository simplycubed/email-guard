# Changelog

All notable changes to this package are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versions follow semver, with an
honest `0.x` while the API settles.

A breaking change ships with a `### Migration` block giving the old call, the new call, and any
config change.

## [Unreleased]

## [0.1.1] - 2026-11-21

No library changes. `src/` is byte-identical to 0.1.0 — verified by unpacking the published
tarball — so every consumer-visible behaviour is unchanged and no migration applies.

This release exists to exercise the release path itself. 0.0.0-stage and 0.1.0 were both published
by hand, so `.github/workflows/publish.yml` has never executed, and neither published version
carries a provenance attestation. 0.1.1 is the first version published by the tag-triggered,
Environment-gated workflow, and therefore the first with a signed build attestation tying the
tarball to the run that produced it. A release path nobody has watched run is a false clear.

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
