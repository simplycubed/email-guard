# @simplycubed/email-guard

Never email someone who did not ask for it.

A small TypeScript library of the checks a signup or lead form needs before it mails anybody:
address checks, signed double opt-in and unsubscribe tokens, rate limiting, and a shared
suppression list. It has **zero runtime dependencies**, uses only Web Crypto and `fetch`, and
runs on Cloudflare Workers and Node 24 or newer.

It owns no database and no mail provider. You hand it storage and a DNS resolver through
small interfaces, and you send the mail yourself.

## Install

```sh
pnpm add @simplycubed/email-guard
```

## What a valid address does and does not prove

A `valid` verdict means the address is well formed, its domain accepts mail, and the domain is
not a known throwaway provider. It does **not** prove the owner asked for your mail: a bot can
type anybody's real address into a form. The only proof of consent is the owner clicking a link
you mailed to that address (double opt-in), which is what the `consent` module is for.

## Modules

### Address checks

```ts
import { checkAddress } from "@simplycubed/email-guard";

const result = await checkAddress("Sam@gmial.com");
// { verdict: "risky", reasons: ["typo_domain"], address: "sam@gmial.com",
//   suggestion: "sam@gmail.com" }
```

Layers, cheapest first: syntax, typo suggestion, disposable domain, role address (`info@`),
then an MX lookup over DNS-over-HTTPS. Verdicts are `valid`, `risky` (let the user continue but
think twice) and `invalid` (do not send). Reasons are stable codes: `invalid_syntax`,
`typo_domain`, `disposable_domain`, `role_address`, `domain_not_found`, `no_mx`, `null_mx`,
`mx_lookup_failed`.

Options: `resolver` (inject your own `DnsResolver`), `skipMx`, `extraDisposableDomains`, and
`disposablePolicy` (`"invalid"` by default, or `"risky"`). A DNS failure is only ever `risky`.

There is deliberately **no SMTP mailbox probing**. Large providers answer every probe the
same way, the answers that do differ are unreliable, and probing from a sending network can get
that network flagged.

The bundled disposable list is a small seed. Add domains for yourself with
`extraDisposableDomains`, or send a pull request to extend the seed.

### Consent: signed tokens and the send decision

```ts
import { signToken, verifyToken, canSendMarketing } from "@simplycubed/email-guard";

const token = await signToken(
  { purpose: "confirm", address: "sam@example.com", ttlSeconds: 48 * 3600 },
  [env.TOKEN_SECRET_CURRENT, env.TOKEN_SECRET_PREVIOUS], // first signs, any verifies
);

const result = await verifyToken(token, [env.TOKEN_SECRET_CURRENT, env.TOKEN_SECRET_PREVIOUS], {
  purpose: "confirm",
});
if (result.valid) {
  // result.address is the normalized address that clicked.
}

const decision = canSendMarketing({
  confirmed: true,
  suppressed: false, // from your own suppression lookup; anything but `false` denies
  lastMarketingSentAt: [], // epoch ms of earlier marketing sends to this address
  now: Date.now(),
});
// { allow: true, reason: "ok" }
```

Tokens are stateless: `base64url(payload).base64url(HMAC-SHA256)`. They are bound to a purpose
(a confirm link cannot be replayed as an unsubscribe link), expire, and verify in constant time.
Secrets must be at least 32 characters (use 32 random bytes). Tokens are signed, not
encrypted, and are replayable until they expire, so make your confirm handler idempotent. `issuedAt` and `now` are epoch milliseconds, and
`ttlSeconds` is in seconds.

`canSendMarketing` is a pure function over facts you supply. It requires a confirmed lead or a
verified, open account, never allows a suppressed address, and caps sends at 1 per rolling 24
hours and 12 per rolling 30 days (override with the second argument).

### Throttle

```ts
import { createThrottle } from "@simplycubed/email-guard";

const throttle = createThrottle(myStore, {
  address: { limit: 3, windowSeconds: 3600 },
  ip: { limit: 20, windowSeconds: 3600 },
});

const gate = await throttle.consumeAll([
  ["address", normalizeAddress(email)],
  ["ip", request.headers.get("cf-connecting-ip") ?? "unknown"],
]);
if (!gate.allowed)
  return new Response("Slow down", {
    status: 429,
    headers: { "retry-after": String(gate.retryAfterSeconds) },
  });
```

`myStore` implements `ThrottleStore` (`get` and an atomic `increment` that sets the expiry only
when it creates the counter). Use a Durable Object, a SQL database or a Postgres upsert. Workers KV is not
atomic and is the wrong store.

### Suppression

```ts
import { suppress, isSuppressed } from "@simplycubed/email-guard";

await suppress(mySuppressionStore, { address, reason: "unsubscribe", source: "my-app" });
if (await isSuppressed(mySuppressionStore, address)) return;
```

Addresses are normalized by `normalizeAddress`: trim, lowercase and drop a trailing domain dot,
nothing more. Mail the normalized address, never the raw input. Plus tags and
provider dot rules are **not** folded, because they are provider-specific guesses and folding
the wrong way would silence a different person.

## A Worker flow: signup form and lead form

```ts
import {
  checkAddress,
  createThrottle,
  isSuppressed,
  normalizeAddress,
  signToken,
  verifyToken,
  canSendMarketing,
  suppress,
} from "@simplycubed/email-guard";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const secrets = [env.TOKEN_SECRET_CURRENT, env.TOKEN_SECRET_PREVIOUS];
    const throttle = createThrottle(env.throttleStore, {
      address: { limit: 3, windowSeconds: 3600 },
      ip: { limit: 20, windowSeconds: 3600 },
    });

    // 1. Lead form: never enroll on submit. Mail a confirm link and stop.
    if (url.pathname === "/lead" && request.method === "POST") {
      const { email } = (await request.json()) as { email: string };
      const address = normalizeAddress(email);

      const gate = await throttle.consumeAll([
        ["address", address],
        ["ip", request.headers.get("cf-connecting-ip") ?? "unknown"],
      ]);
      if (!gate.allowed) return new Response("Too many requests", { status: 429 });

      const check = await checkAddress(address);
      if (check.verdict === "invalid")
        return Response.json({ ok: false, reasons: check.reasons }, { status: 422 });
      if (await isSuppressed(env.suppressionStore, address)) return Response.json({ ok: true }); // say nothing

      const token = await signToken(
        { purpose: "confirm", address, ttlSeconds: 48 * 3600 },
        secrets,
      );
      await env.sendMail({ to: address, link: `${url.origin}/confirm?t=${token}` });
      return Response.json({ ok: true, suggestion: check.suggestion });
    }

    // 2. Confirm link: only now is the lead enrolled. Use a POST from a confirm page, so a
    //    mail scanner that pre-fetches links cannot confirm for the owner.
    if (url.pathname === "/confirm" && request.method === "POST") {
      const result = await verifyToken(url.searchParams.get("t") ?? "", secrets, {
        purpose: "confirm",
      });
      if (!result.valid) return new Response("Link invalid or expired", { status: 400 });
      await env.enrollLead(result.address);
      return Response.json({ ok: true });
    }

    // 3. Unsubscribe link: stateless, then recorded in the shared suppression list.
    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      const result = await verifyToken(url.searchParams.get("t") ?? "", secrets, {
        purpose: "unsubscribe",
      });
      if (!result.valid) return new Response("Link invalid or expired", { status: 400 });
      await suppress(env.suppressionStore, {
        address: result.address,
        reason: "unsubscribe",
        source: "my-app",
      });
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },
};

// 4. Before every marketing send (a cron stepper, for example):
async function mayMail(env: Env, address: string): Promise<boolean> {
  const row = await env.loadContactFacts(address); // your database
  const decision = canSendMarketing({
    confirmed: row.confirmed,
    accountVerified: row.accountVerified,
    accountClosed: row.accountClosed,
    suppressed: await isSuppressed(env.suppressionStore, address),
    lastMarketingSentAt: row.sentTimestamps,
    now: Date.now(),
  });
  return decision.allow;
}
```

## Testing your integration

`@simplycubed/email-guard/testing` exports in-memory stores and a fake resolver so your tests
never touch a network or a database:

```ts
import {
  createMemoryThrottleStore,
  createMemorySuppressionStore,
  createFakeResolver,
} from "@simplycubed/email-guard/testing";

const resolver = createFakeResolver({
  "example.com": { kind: "records", exchanges: ["mx.example.com"] },
});
await checkAddress("sam@example.com", { resolver });
```

## Development

```sh
pnpm install
pnpm check   # lint, typecheck, tests with coverage thresholds, build, leak scan
```

Node 24 or newer. The leak scan (`scripts/no-leaks.mjs`) keeps product names, internal hostnames
and secret-shaped strings out of everything that ships.

## License

MIT
