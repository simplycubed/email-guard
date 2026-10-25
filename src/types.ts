/** Result of one MX lookup. A lookup that could not be completed is `error`, never a guess. */
export type MxLookup =
  | {
      kind: "records";
      /** Mail exchanger hostnames. An empty list means the domain exists but takes no mail. */
      exchanges: readonly string[];
    }
  | { kind: "nxdomain" }
  | { kind: "error"; message: string };

/** Injectable DNS resolver. The default is `createDohResolver()`. */
export interface DnsResolver {
  resolveMx(domain: string): Promise<MxLookup>;
}

export type AddressVerdict = "valid" | "risky" | "invalid";

export type AddressReason =
  | "invalid_syntax"
  | "domain_not_found"
  | "no_mx"
  | "null_mx"
  | "mx_lookup_failed"
  | "disposable_domain"
  | "typo_domain"
  | "role_address";

export interface AddressCheck {
  verdict: AddressVerdict;
  reasons: AddressReason[];
  /** The normalized address (see `normalizeAddress`). */
  address: string;
  /** Present with `typo_domain`: the full address the user probably meant. */
  suggestion?: string;
}

export interface CheckAddressOptions {
  /** Resolver for the MX layer. Defaults to a Cloudflare DNS-over-HTTPS resolver. */
  resolver?: DnsResolver;
  /** Skip the MX layer entirely (no network). Defaults to false. */
  skipMx?: boolean;
  /** Extra throwaway domains, added to the bundled seed list. */
  extraDisposableDomains?: Iterable<string>;
  /** `invalid` (default) rejects disposable domains; `risky` only flags them. */
  disposablePolicy?: "invalid" | "risky";
}

export type ConsentDenyReason =
  "suppressed" | "account_closed" | "not_confirmed" | "daily_cap" | "monthly_cap";

export interface MarketingState {
  /** The address clicked a double opt-in confirm link (a lead). */
  confirmed: boolean;
  /** The address belongs to an account whose email was verified. */
  accountVerified?: boolean;
  /** The account is closed or deactivated. */
  accountClosed?: boolean;
  /**
   * The address is on a suppression list. Required, and anything but an explicit `false`
   * denies, so forgetting the lookup can never read as "not suppressed".
   */
  suppressed: boolean;
  /** Epoch milliseconds of each marketing email already sent to this address. */
  lastMarketingSentAt: readonly number[];
  /** Epoch milliseconds, supplied by the caller so the decision stays pure. */
  now: number;
}

export interface MarketingCaps {
  /** Maximum marketing emails per rolling 24 hours. Default 1. */
  perDay?: number;
  /** Maximum marketing emails per rolling 30 days. Default 12. */
  perMonth?: number;
}

export type MarketingDecision =
  { allow: true; reason: "ok" } | { allow: false; reason: ConsentDenyReason; retryAt?: number };

export interface TokenPayload {
  /** What the token is for, for example `confirm` or `unsubscribe`. Binds the token. */
  purpose: string;
  address: string;
  /** Epoch milliseconds. Defaults to now. */
  issuedAt?: number;
  /** Lifetime in seconds. */
  ttlSeconds: number;
}

export type TokenFailure =
  "malformed" | "bad_signature" | "wrong_purpose" | "expired" | "not_yet_valid";

export type TokenResult =
  | {
      valid: true;
      purpose: string;
      /** Normalized address. */
      address: string;
      issuedAt: number;
      expiresAt: number;
    }
  | { valid: false; reason: TokenFailure };

export interface VerifyTokenOptions {
  /** The purpose the caller expects. A correctly signed token for another purpose fails. */
  purpose: string;
  /** Epoch milliseconds. Defaults to now. */
  now?: number;
  /** Tolerated clock skew for `issuedAt` in the future, in seconds. Default 60. */
  clockSkewSeconds?: number;
}

export interface ThrottleRule {
  limit: number;
  windowSeconds: number;
}

export interface ThrottleCounter {
  count: number;
  /** Epoch milliseconds at which the counter resets. */
  expiresAt: number;
}

/**
 * Counter storage supplied by the consumer. `increment` MUST be atomic and MUST set the
 * expiry only when it creates the counter (fixed window). Workers KV is not atomic and is
 * the wrong backing store; use a Durable Object, SQL database or Postgres upsert.
 */
export interface ThrottleStore {
  get(key: string): Promise<ThrottleCounter | null>;
  increment(key: string, ttlSeconds: number): Promise<ThrottleCounter>;
}

export interface ThrottleResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface Throttle {
  /** Count one attempt against `rule` for `id` and say whether it is within the limit. */
  consume(rule: string, id: string): Promise<ThrottleResult>;
  /** Read the current state without counting an attempt. */
  peek(rule: string, id: string): Promise<ThrottleResult>;
  /** Count one attempt against every pair. Allowed only if all are. */
  consumeAll(pairs: ReadonlyArray<readonly [rule: string, id: string]>): Promise<ThrottleResult>;
}

export type SuppressionReason = "unsubscribe" | "hard_bounce" | "complaint" | "manual";

export interface SuppressionEntry {
  /** Always normalized. */
  address: string;
  reason: SuppressionReason;
  /** Which product or system recorded it. Free text chosen by the consumer. */
  source: string;
  /** Epoch milliseconds. */
  addedAt: number;
}

/** Suppression storage supplied by the consumer. Receives normalized addresses only. */
export interface SuppressionStore {
  add(entry: SuppressionEntry): Promise<void>;
  has(address: string): Promise<boolean>;
}
