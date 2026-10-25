import type {
  Throttle,
  ThrottleCounter,
  ThrottleResult,
  ThrottleRule,
  ThrottleStore,
} from "./types.js";

export interface ThrottleOptions {
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

const MAX_ID_LENGTH = 512;

/**
 * `fresh` is true for the counter an `increment` just returned: it is live by definition, so
 * its `expiresAt` is not compared with this process's clock (a store clock that disagrees
 * with ours must not switch the limit off). A counter from `get` is checked against `now`.
 */
function resultFor(
  rule: ThrottleRule,
  counter: ThrottleCounter | null,
  now: number,
  fresh: boolean,
): ThrottleResult {
  if (counter === null || (!fresh && counter.expiresAt <= now)) {
    return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };
  }
  if (!Number.isFinite(counter.count) || counter.count < 1) {
    throw new Error("email-guard: throttle store returned an invalid counter");
  }
  const allowed = counter.count <= rule.limit;
  const wait = Math.ceil((counter.expiresAt - now) / 1000);
  return {
    allowed,
    remaining: Math.max(0, rule.limit - counter.count),
    retryAfterSeconds: allowed
      ? 0
      : Math.min(rule.windowSeconds, Math.max(1, Number.isFinite(wait) ? wait : 1)),
  };
}

/**
 * Fixed-window rate limiter over a consumer-supplied counter store. Rules are named
 * (`address`, `ip`, ...) and each call names a rule and an id, so one throttle serves a
 * whole signup flow. Every `consume` counts, allowed or not: an attacker hammering a
 * limit stays limited instead of resetting the window by being refused.
 *
 * Ids are used as given, up to 512 characters. Pass `normalizeAddress(email)` for address rules.
 * Plus tags are not folded, so `a+1@x.com` and `a+2@x.com` are two ids: pair an address rule
 * with an IP rule and a per-domain rule. Store errors propagate (the caller picks fail-open or
 * fail-closed); the ids end up in the store's keys, so hash them if the store is shared or
 * logged.
 */
export function createThrottle(
  store: ThrottleStore,
  rules: Readonly<Record<string, ThrottleRule>>,
  options: ThrottleOptions = {},
): Throttle {
  const clock = options.now ?? Date.now;
  for (const [name, rule] of Object.entries(rules)) {
    if (
      !Number.isInteger(rule.limit) ||
      rule.limit < 1 ||
      !Number.isInteger(rule.windowSeconds) ||
      rule.windowSeconds < 1
    ) {
      throw new Error(
        `email-guard: throttle rule "${name}" needs integer limit and windowSeconds >= 1`,
      );
    }
  }

  const ruleFor = (name: string): ThrottleRule => {
    const rule = Object.hasOwn(rules, name) ? rules[name] : undefined;
    if (rule === undefined) throw new Error(`email-guard: unknown throttle rule "${name}"`);
    return rule;
  };
  const assertId = (id: string): void => {
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
      throw new Error(`email-guard: throttle id must be 1 to ${MAX_ID_LENGTH} characters`);
    }
  };
  const keyFor = (rule: string, id: string): string => `eg:throttle:${rule}:${id}`;

  async function consume(name: string, id: string): Promise<ThrottleResult> {
    const rule = ruleFor(name);
    assertId(id);
    const counter = await store.increment(keyFor(name, id), rule.windowSeconds);
    return resultFor(rule, counter, clock(), true);
  }

  async function peek(name: string, id: string): Promise<ThrottleResult> {
    const rule = ruleFor(name);
    assertId(id);
    return resultFor(rule, await store.get(keyFor(name, id)), clock(), false);
  }

  async function consumeAll(
    pairs: ReadonlyArray<readonly [rule: string, id: string]>,
  ): Promise<ThrottleResult> {
    if (pairs.length === 0) throw new Error("email-guard: consumeAll needs at least one rule");
    const results: ThrottleResult[] = [];
    for (const [name, id] of pairs) results.push(await consume(name, id));
    return {
      allowed: results.every((r) => r.allowed),
      remaining: Math.min(...results.map((r) => r.remaining)),
      retryAfterSeconds: Math.max(...results.map((r) => r.retryAfterSeconds)),
    };
  }

  return { consume, peek, consumeAll };
}
