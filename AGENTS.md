# AGENTS.md: `@simplycubed/email-guard`

- `AGENTS.md` is the repo-local source of truth for agent instructions, and the contract for this
  package's design decisions. There is no `CLAUDE.md` or other shim: agents read this file
  directly. Where this file states a decision, implement that decision rather than re-deriving an
  alternative. If a decision turns out to be wrong, change this file in the same PR that changes
  the code, with the reason.
- Details live in [`docs/SPEC.md`](docs/SPEC.md). This file holds the rules and decisions.

A small, dependency-free TypeScript library that stops an application from emailing someone who
did not ask for it, or a bot-created account. It is a reusable public package, published to npm as
`@simplycubed/email-guard`, and must make sense to a reader who knows nothing about its authors'
other software. It runs on Cloudflare Workers and Node 24 or newer. It owns no database and no mail
provider: the consumer supplies those through small interfaces.

## The one rule that shapes everything

**This package decides whether an address may be mailed. It never decides how, and it never
holds state.**

Everything that looks like restraint follows from this:

- No database client, no mail provider SDK, no HTTP framework. Storage (`ThrottleStore`,
  `SuppressionStore`) and DNS (`DnsResolver`) are interfaces; the consumer brings adapters. The
  only I/O the package performs itself is the default DNS-over-HTTPS resolver, built on `fetch`,
  and it is injectable.
- Verdicts and decisions are values, not side effects. `checkAddress` returns a verdict,
  `canSendMarketing` returns an allow or deny with a reason, and the caller acts.
- Consent is proven by a clicked link, never inferred. A syntactically and DNS-valid address proves
  an address can receive mail, not that its owner signed up.
- When in doubt, do not send. Unknown, closed, unconfirmed, suppressed and capped all deny.

## Decisions

1. **Four modules, one barrel.** `address`, `consent` (tokens plus `canSendMarketing`),
   `throttle`, `suppression`, plus the shared `normalizeAddress`. Keep the public API small: a new
   export needs a consumer that cannot work without it.
2. **No SMTP mailbox probing, ever.** Large providers answer every probe the same way, the
   answers that differ are unreliable, and probing from a sending network can get it flagged. If
   mailbox verification is ever wanted, a paid vendor behind the same `checkAddress` shape is the
   route, in a separate adapter.
3. **Normalization is trim, lowercase and a dropped trailing domain dot, nothing else.** The
   trailing dot is the DNS root and names the same host. Plus tags and provider dot rules are not
   folded: a fold is a provider-specific guess, and guessing wrong silences or mails a different
   person. Consumers mail `AddressCheck.address` (normalized), never the raw input.
4. **Tokens are stateless HMAC-SHA256 on Web Crypto.** Purpose is inside the signed payload, so a
   confirm link can never be replayed as an unsubscribe link. Secrets are at least 32 characters;
   an array supports rotation (first signs, any verifies). Verification uses `crypto.subtle.verify`
   (constant time) and tries every key without early exit. Non-canonical base64url MACs are
   rejected. Tokens are signed, not encrypted: the address is readable by whoever holds the link.
   Single use is the consumer's job (tokens are replayable until expiry). Timestamps are epoch
   milliseconds; TTLs are seconds.
5. **A DNS failure is `risky`, never `invalid`.** Only an authoritative NXDOMAIN, an empty MX set
   or an RFC 7505 null MX is invalid. A hiccup must not reject a real person.
6. **Disposable domains are `invalid` by default**, downgradable with `disposablePolicy: "risky"`.
   The bundled list is a small seed in `src/disposable-domains.ts`: add lowercase registrable
   domains in alphabetical order, run `pnpm check`, release. Consumers add their own with
   `extraDisposableDomains`.
7. **Throttle counts every attempt, refused or not**, so a refused attacker cannot reset the
   window. `ThrottleStore.increment` must be atomic. Workers KV is not.
8. **`canSendMarketing` is pure and fails closed.** Facts in, decision out. A missing or non-boolean
   `suppressed`, or a non-numeric send timestamp, denies. The caps (1 per rolling 24 hours, 12 per
   rolling 30 days) are defaults the consumer may override with integers of at least 1, never
   remove.
9. **One suppression list per sender.** A consumer that runs several applications can share one
   store across them, so an unsubscribe in one silences all. The first recorded reason for an
   address is kept. Entries are personal data: the consumer owns retention.
10. **Untrusted input is bounded.** Addresses, domains, throttle ids and DNS answers all have length
    caps, and addresses containing whitespace, control or zero-width characters are refused by
    `signToken` and `suppress`. The DoH endpoint is https only and fixed by the consumer.

## Gate

`pnpm check` = lint → typecheck → test (coverage thresholds) → build → no-leaks.

**Gate-first, every feature:** no feature work begins until its gate exists; extend the gate first,
then build the feature against it. A gate nobody has watched fire is a false clear, so every new
check lands with a negative control.

### The leak scan

`scripts/no-leaks.mjs` runs over `src/`, `dist/`, `README.md`, `package.json`, `AGENTS.md`,
`CHANGELOG.md`, `docs/` and `.github/`: everything an npm consumer or a visitor to the public
repository can read. It fails on:

- names of products that consume this library, in any spacing or separator,
- the owner's personal name, and legal-entity suffixes,
- the organization name and its hostnames (allowed only as the package scope and repository path,
  and in `LICENSE`),
- internal-looking hostnames,
- secret-shaped strings: private key blocks, live payment keys, webhook signing secrets, cloud and
  registry tokens, long hex runs and long base64 runs.

`test/no-leaks.test.ts` proves each category can go red and that a missing scan root hard-fails
rather than passing vacuously. **Never weaken a pattern to make a scan pass: remove the leak.**
Tests use `example.com` addresses and fake secrets assembled from fragments.

**Keep this repository generic.** Integration plans, incident write-ups, file paths from consuming
applications, infrastructure identifiers and customer data belong in a private repository, not here.
Commit messages, PR descriptions and issues are public too.

## Publishing

**Publish on a `v*` tag, never on merge.** A published version is immutable, which puts it in the
same irreversible class as a prod deploy. **Releasing is the owner's action: agents never create
tags, never create the `publish` environment and never publish.**

`.github/workflows/publish.yml` is two jobs:

1. `verify` (ungated): assert the tag matches `package.json` version
   (`scripts/assert-tag-version.mjs`, which takes the raw `refs/tags/` ref), install, run
   `pnpm check`, and upload the exact `dist/` that passed.
2. `publish` (`environment: publish`, `id-token: write`): download that `dist/`, check it arrived
   intact, re-assert the tag, then `pnpm publish --no-git-checks --provenance --access public`.
   Authorization is npm trusted publishing over OIDC: no npm token is stored anywhere. `verify`
   also requires the tagged commit to be reachable from `main`. Actions are pinned by commit SHA.

The human approval attaches to the `publish` environment (required reviewer), so it comes last,
on the irreversible step only, after the evidence from `verify` exists. An environment with no
protection rule is a silent no-op, so confirm the reviewer is set before trusting the gate.

The package is public (`publishConfig.access: "public"`). npm trusted publishing needs the package
to exist already: publish `0.1.0` once by hand with two-factor authentication, then configure the
trusted publisher (repository, workflow file, `publish` environment) and release from CI.
Provenance needs a public repository.

## Conventions

- **No attribution in commits or PRs:** never a `Co-Authored-By` trailer, a "Generated with…" line,
  or any tool-attribution text.
- TypeScript strict, ESM only, **zero runtime dependencies** (a dependency here is inherited by
  every Worker in the portfolio).
- Imports carry explicit `.js` specifiers so the emitted ESM resolves under plain Node.
- Ship compiled JS + `.d.ts`, not raw TypeScript. `./testing` is a separate subpath so the test
  kit never lands in a Worker bundle.
- Table-driven tests. **No test ever reaches the network.** This repo holds no credentials and no
  real addresses; use `example.com`.
- Keep a `### Migration` block in `CHANGELOG.md` for any breaking change.
- Never log or put into an error message an address, a token or a secret.
