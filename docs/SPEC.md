# email-guard specification

Status: first implementation, version 0.1.0. The rules and decisions are in
[`AGENTS.md`](../AGENTS.md); this document gives the details.

## Purpose

Stop applications from emailing people who did not ask for it, and from emailing accounts created by
bots. A bot can type anybody's real address into a signup or lead form; if the application then
mails or enrolls that address, the owner receives mail they never requested.

Two facts shape the design:

1. Validation proves an address can **receive** mail. It cannot prove its owner **asked** for it. Only
   a clicked link in a message sent to that address proves that.
2. The cheapest layers are free and instant; the expensive, unreliable layers (SMTP probing) cost more
   than they help and can damage sending reputation.

## Consumers

| Consumer type                        | Runtime                | Storage           | Mail sending      |
| ------------------------------------ | ---------------------- | ----------------- | ----------------- |
| SaaS with accounts and a nurture job | Workers or Node        | any SQL database  | consumer's choice |
| Waitlist and marketing site          | Workers, Pages or Node | SQL or similar    | consumer's choice |
| Alerting or monitoring product       | Workers or Node        | consumer's choice | consumer's choice |

The package takes none of those as dependencies. Each consumer writes thin adapters for the
interfaces below.

## Non-goals

- No SMTP mailbox probing (see "Why not mailbox probing").
- No mail sending, templating or provider SDKs.
- No database access, schema or migrations. Consumers own their tables.
- No bounce or complaint **ingestion**. The package defines where a bounce is recorded
  (`suppress` with `hard_bounce` or `complaint`); parsing a provider's webhooks is the consumer's.
- No captcha. Turnstile and similar are consumer-side; the package only provides the throttle.
- No hosted service. It is a library.

## Module: `address`

```ts
checkAddress(email: string, opts?: CheckAddressOptions): Promise<AddressCheck>
// AddressCheck = { verdict: "valid" | "risky" | "invalid"; reasons: AddressReason[];
//                  address: string; suggestion?: string }
```

Layers, in order. Each reason is a stable code.

| Layer             | Reason                                 | Verdict              |
| ----------------- | -------------------------------------- | -------------------- |
| Syntax            | `invalid_syntax`                       | invalid (stops here) |
| Typo suggestion   | `typo_domain` (+ `suggestion`)         | risky                |
| Disposable domain | `disposable_domain`                    | invalid (or risky)   |
| Role address      | `role_address`                         | risky                |
| MX lookup         | `domain_not_found`, `no_mx`, `null_mx` | invalid              |
| MX lookup failed  | `mx_lookup_failed`                     | risky                |

Verdict rule: any invalid reason gives `invalid`, otherwise any reason gives `risky`, otherwise
`valid`. Invalid reasons are listed before risky ones.

- **Syntax.** One `@`; ASCII dot-atom local part up to 64 characters; at least two domain labels, each
  up to 63 characters, letters, digits and inner hyphens; a letter-only or punycode TLD; 254
  characters in all. Quoted local parts, IP literals and raw Unicode are rejected (internationalized
  domains must arrive as punycode).
- **Typos.** A table of common misspellings (`gmial.com`, `hotmial.com`, ...) plus `.con`, `.cmo`,
  `.ocm`, `.vom` to `.com`. The suggestion is the full corrected address. A typo is `risky`, not
  `invalid`, because the user may know better; the form should show the suggestion.
- **Disposable.** Matches the domain or any parent of it, against the bundled seed plus
  `extraDisposableDomains`. Default policy `invalid`; `disposablePolicy: "risky"` softens it.
- **Role.** `info`, `admin`, `support`, `noreply`, ... (list in `src/disposable-domains.ts`). These
  are rarely a person who chose to sign up.
- **MX.** Through an injected `DnsResolver`. The MX layer is skipped when an earlier layer already made
  the address invalid or the domain is a known typo, to save a query. `skipMx: true` disables it
  (offline use).

```ts
interface DnsResolver {
  resolveMx(domain: string): Promise<MxLookup>;
}
type MxLookup =
  | { kind: "records"; exchanges: readonly string[] } // empty = exists but takes no mail
  | { kind: "nxdomain" }
  | { kind: "error"; message: string };
```

`createDohResolver({ endpoint?, fetch?, timeoutMs? })` is the default: JSON DNS-over-HTTPS using
only `fetch` (Cloudflare's endpoint by default, 3 second timeout). An MX miss falls back to an A or
AAAA record as an implicit MX (RFC 5321). A null MX (`0 .`, RFC 7505) is reported as `["."]`.
Transport errors, non-200 replies, unreadable bodies and rcodes other than NOERROR and NXDOMAIN are
`error`, never `nxdomain`.

### Updating the disposable list

The seed is intentionally small and curated. To add domains: edit `DISPOSABLE_DOMAINS` in
`src/disposable-domains.ts`, keep it lowercase and alphabetical, run `pnpm check`, and release. A
consumer that cannot wait passes `extraDisposableDomains`. Pulling a large community list is a
possible later addition, as a separate, reviewed, generated file; it is not done in 0.1.0.

### Why not mailbox probing

An SMTP probe opens a conversation with the recipient's mail server up to `RCPT TO` and hangs up.
Large providers and many corporate servers accept everything or refuse probes, so the common
answers are "unknown" or "catch-all". The remaining signal is unreliable, and probing from a
sending network can get that network blocklisted. Out of scope by decision; a paid vendor behind
the same result shape is the route if it is ever needed.

## Module: `consent`

### Tokens

```ts
signToken({ purpose, address, issuedAt?, ttlSeconds }, secret | secrets[]): Promise<string>
verifyToken(token, secret | secrets[], { purpose, now?, clockSkewSeconds? }): Promise<TokenResult>
```

Format: `base64url(JSON{v,p,a,i,e}).base64url(HMAC-SHA256(body))`. `p` purpose, `a` normalized
address, `i` issued-at, `e` expiry, both epoch milliseconds. Verification order: shape and length,
signature (every key, no early exit, `crypto.subtle.verify`), payload structure, purpose, not-yet-valid
(beyond `clockSkewSeconds`, default 60), expiry (`now >= e` is expired).

| Failure         | Meaning                                                     |
| --------------- | ----------------------------------------------------------- |
| `malformed`     | wrong shape, over 2048 characters, bad base64url or payload |
| `bad_signature` | no supplied key signed it                                   |
| `wrong_purpose` | signed correctly, but for another purpose                   |
| `expired`       | past its lifetime                                           |
| `not_yet_valid` | issued in the future beyond the allowed skew                |

Constraints: secrets at least 32 characters; purpose matches `/^[a-z0-9][a-z0-9_.:-]{0,63}$/`;
`ttlSeconds` a positive integer up to 400 days. Key rotation: deploy `[new, old]`, wait one max TTL,
drop `old`.

Typical purposes: `confirm` (double opt-in, 24 to 72 hours) and `unsubscribe` (long-lived, since it
sits in old emails). **A link in an email must land on a page that POSTs the token**: a plain GET
that changes state can be triggered by a mail scanner that pre-fetches links.

Tokens are bearer proof, replayable until expiry. Confirming twice is harmless if the consumer's
confirm handler is idempotent; for a one-time action, record the token's hash after use. Tokens are
signed, not encrypted: the base64url body shows the address and purpose to anyone holding the link,
so serve the landing page with `Referrer-Policy: no-referrer` and keep tokens out of access logs.
Secrets are used as UTF-8 text: generate at least 32 random bytes (for example 64 hex characters);
the length check cannot detect a weak secret. Tokens with non-canonical base64url MACs are rejected,
so one token has exactly one valid string. `signToken` refuses addresses that are not
mailbox-shaped.

### `canSendMarketing`

```ts
canSendMarketing(state: MarketingState, caps?: { perDay?: number; perMonth?: number }): MarketingDecision
```

Pure and fail closed. Order of checks: `suppressed` (denies unless `suppressed === false`, so the
caller must look the address up), `account_closed`, `not_confirmed` (needs `confirmed` or
`accountVerified`), `daily_cap` (default 1 per rolling 24 hours), `monthly_cap` (default 12 per rolling
30 days). Cap denials carry `retryAt` (epoch ms). Future and non-finite timestamps count as inside
the window. Caps must be integers of at least 1 or the call throws.

This governs marketing and lifecycle nurture. Mail the person just asked for (the confirm link
itself, a receipt) is transactional and does not pass through it.

## Module: `throttle`

```ts
createThrottle(store: ThrottleStore, rules: Record<string, { limit; windowSeconds }>, { now? }?): Throttle
throttle.consume(rule, id) / peek(rule, id) / consumeAll([[rule, id], ...]): Promise<ThrottleResult>
// ThrottleResult = { allowed: boolean; remaining: number; retryAfterSeconds: number }
```

Fixed window. `consume` counts the attempt, allowed or not. Ids are 1 to 512 characters and are used
as given (they become part of the store key), so pass a normalized address, or a hash of one. `consumeAll` counts every pair and is
allowed only if all are; `remaining` is the minimum and `retryAfterSeconds` the maximum. Rules are
validated at creation; an unknown rule name throws.

```ts
interface ThrottleStore {
  get(key: string): Promise<{ count: number; expiresAt: number } | null>;
  increment(key: string, ttlSeconds: number): Promise<{ count: number; expiresAt: number }>;
}
```

`increment` must be atomic and must set the expiry only when it creates the counter. Suitable:
Durable Objects, a SQL database or Postgres upsert. Not suitable: Workers KV (not atomic, eventually
consistent). Store errors propagate; the consumer chooses fail-open or fail-closed. Recommended for
signup and lead forms: **fail closed on the confirm-link mailer, fail open nowhere that sends mail.**

Typical rules: per address (3 per hour), per IP (20 per hour), per address per day for verification
mail (1 per hour), and a per-domain rule, because plus tags make `a+1@x.com` and `a+2@x.com` two
ids. The counter returned by `increment` is trusted as live (its `expiresAt` is not compared with the
local clock), so a store clock that disagrees with ours cannot disable a limit.

## Module: `suppression`

```ts
interface SuppressionStore { add(entry: SuppressionEntry): Promise<void>; has(address: string): Promise<boolean> }
suppress(store, { address, reason, source, now? }): Promise<SuppressionEntry>
isSuppressed(store, address): Promise<boolean>
// reason: "unsubscribe" | "hard_bounce" | "complaint" | "manual"; source: free-text product label
```

Stores receive **normalized** addresses only. A consumer running several applications can share one
store (many sources), so an unsubscribe anywhere silences everywhere. Adding an address that is
already present should keep the first record. `suppress` refuses values that are not
mailbox-shaped (one `@`, no whitespace, control or zero-width characters, at most 254 characters).

## Normalization

`normalizeAddress` is trim, lowercase, and drop trailing dots from the domain (`a@example.com.` is
the same host as `a@example.com`). It is the only normalizer in the package and every module uses it.
Plus-addressing is not stripped, and gmail dots are not removed: both are provider guesses, and an
over-eager fold would suppress or mail a different mailbox. Lowercasing folds a few non-ASCII
characters onto ASCII (the Kelvin sign becomes `k`), so **mail the normalized address
(`AddressCheck.address`), never the raw input**. `splitAddress` returns
`{ local, domain }` of a normalized address, or null.

## Test kit (`./testing`)

`createMemoryThrottleStore(now?)`, `createMemorySuppressionStore()` (with `entries()`),
`createFakeResolver(table)` (unknown domain is NXDOMAIN; records `calls`). In-memory only, never for
production.

## Security notes

- **Input bounds.** Addresses up to 254 characters; domains up to 253; throttle ids up to 512; DoH
  answers capped at 64 records and exchanger names at 255 characters; tokens at 2048 characters.
  The syntax patterns have no nested quantifiers, so they run in linear time.
- **DNS-over-HTTPS.** The endpoint must be an https URL and must come from your configuration, never
  from user input (the library does not block private addresses, because it never accepts an
  endpoint from a request). Every domain you check is sent to the resolver, so choose one you are
  content to share that with. A resolver failure is `risky`, never `invalid`.
- **Fail-open versus fail-closed.** Store errors propagate from the throttle and suppression
  functions, and the consumer decides. For anything that sends mail, fail closed.
- **Tokens never log.** Error messages contain neither addresses, tokens nor secrets.

## Data handling

The library keeps no state and writes no logs. Personal data passes through it as follows:

| Data                      | Where it goes                                                              |
| ------------------------- | -------------------------------------------------------------------------- |
| Email address             | Token body (readable), suppression entries, throttle keys (if used as ids) |
| Domain part of an address | The DNS-over-HTTPS resolver, in the query                                  |
| IP address                | Only if you use it as a throttle id; it is then a store key                |

Guidance for consumers: set a TTL on throttle keys (the interface passes one); store suppression
entries for as long as the legal basis lasts (a suppression record is itself personal data, but it
is what honors the person's request, so retain it and document why); store a hash of the address
(for example SHA-256 of the normalized address) in shared or widely readable stores, remembering
that a hash of an email is pseudonymous, not anonymous. Honor deletion requests for everything
except suppression entries, or replace those with hashes. The bundled disposable-domain and typo
lists are hand-written facts about public domain names, not copied from a third-party feed.

## Quality gate

Strict TypeScript, ESM, zero runtime dependencies. Coverage thresholds: 95 percent statements, lines
and functions, 90 percent branches. All tests are hermetic: no network, no real addresses, fake
secrets built from fragments. The leak scan covers `src`, `dist`, `README.md`, `package.json`,
`AGENTS.md`, `CHANGELOG.md`, `docs` and `.github`.

## Release

Tag `vX.Y.Z` triggers the two-job publish workflow; the owner approves the `publish` environment.
Version `0.1.0` is the first release. See AGENTS.md "Publishing".
