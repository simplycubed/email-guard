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

**Extend the gate by adding steps to `pnpm check`, not by adding workflows.** One documented
exception: `.github/workflows/codeql.yml`. CodeQL cannot run as a local command — it needs the
`github/codeql-action` runner and `security-events: write` to upload SARIF to the code-scanning
API — so it is a separate workflow by necessity. It is scoped to stay out of the gate's way: it
does not touch the `check` job or its check-run context string, and it is **not** a required
status check, because a required check on a workflow that has never produced a result deadlocks
every PR. Findings land in Security → Code scanning, not in a red PR. Anything that _can_ run as
a local command still belongs in `pnpm check`; do not read this exception as permission to add
workflows generally.

### Two TypeScript compilers, on purpose

`pnpm check` builds and typechecks with **TypeScript 7**, and lints with the **TypeScript 6 API**.
Both are installed, and the aliasing in `package.json` is deliberate:

```json
"@typescript/native": "npm:typescript@^7.0.2",
"typescript": "npm:@typescript/typescript6@^6.0.2"
```

`tsc` comes from `@typescript/native` (the real `typescript` package, 7.x) and is what `typecheck`
and `build` run. `require("typescript")` resolves to `@typescript/typescript6`, which is what
eslint loads. `tsc6` is also on PATH for comparing compilers.

The reason is a single hard guard. `typescript-eslint/dist/index.js` reads `ts.versionMajor` at
module load and throws `typescript-eslint does not support TS 7.0.` when it is 7 or higher. No
option disables it: `onUnsupportedTypeScriptVersion: 'ignore'` only governs the softer range
warning inside typescript-estree, not this guard. So the compiler eslint sees has to be 6.x, and
this layout is the arrangement Microsoft documents for running the two lines side by side.

Two things to know before changing it:

- **Do not "simplify" this to one `typescript` entry.** Pointing `typescript` at 7.x puts `pnpm
lint` back to a hard crash, and pointing it at 6.x silently downgrades the build compiler.
- **Typed linting would run on TS 6, not TS 7.** Irrelevant today because `eslint.config.js` uses
  `tseslint.configs.recommended`, the syntactic rule set, which never builds a program. It becomes
  relevant the moment anything type-aware is adopted.

Package version is not compiler version here: `@typescript/typescript6@6.0.2` ships TypeScript
6.0.3, so `tsc6 --version` and the package range disagree. That is expected, not a mismatch.

Consumers are unaffected by any of this. A library's compatibility surface is its emitted `.d.ts`,
not its devDependency: the declarations TS 7 emits are byte-identical to those TS 5.9.3 emitted,
and a consumer typechecks cleanly on 5.9.3, 6.0.3 and 7.0.2 with `skipLibCheck` off. Nothing
downstream needs to pin a TypeScript version. This collapses back to one compiler when
typescript-eslint ships a release accepting 7.x (issue #7, upstream
typescript-eslint/typescript-eslint#10940).

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

**There is no human approval on publish.** The `publish` environment held a required reviewer
until 2026-11-21, when it was removed by owner decision; it now carries no protection rules, so a
`v*` tag publishes to npm unattended. The `environment: publish` line in the workflow stays
regardless, because the npm Trusted Publisher is scoped to that environment name and a job running
outside it fails the OIDC exchange.

What this makes load-bearing: nothing stops an unintended publish except the tag itself. `verify`
still runs the full gate and still refuses a tag that is off `main` or disagrees with
`package.json`, so a tag cannot publish arbitrary code. But a tag pushed by accident, or at the
wrong commit, publishes immediately and immutably. Treat creating a `v*` tag as the irreversible
act it now is: there is no longer a second chance between the push and the registry. An
environment with no protection rule is a silent no-op, so read
`gh api repos/simplycubed/email-guard/environments/publish` rather than inferring the gate from
the workflow.

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
