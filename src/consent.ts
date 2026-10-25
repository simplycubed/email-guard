import type { MarketingCaps, MarketingDecision, MarketingState } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

function cap(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`email-guard: caps.${name} must be an integer of at least 1`);
  }
  return value;
}

/**
 * The pure "may we send marketing to this address right now" decision. It reads only the
 * facts the caller supplies, so it is trivially testable and has no hidden storage.
 *
 * Policy, in order:
 *   1. never when the address is suppressed, or when `suppressed` is not an explicit `false`;
 *   2. never when the account is closed;
 *   3. require a basis: a confirmed double opt-in (a lead), OR a verified account that is
 *      not closed. Anything else, including an unverified signup, is `not_confirmed`;
 *   4. global caps over the sends already made: 1 per rolling 24 hours and 12 per rolling
 *      30 days by default. Timestamps in the future count as inside the window, which is
 *      the conservative reading of a bad clock.
 *
 * This governs marketing and lifecycle nurture mail. Transactional mail a person asked
 * for (a confirm link, a receipt) does not go through it.
 */
export function canSendMarketing(
  state: MarketingState,
  caps: MarketingCaps = {},
): MarketingDecision {
  if (!Number.isFinite(state.now)) throw new Error("email-guard: state.now must be a number");
  const perDay = cap("perDay", caps.perDay, 1);
  const perMonth = cap("perMonth", caps.perMonth, 12);

  // Anything but an explicit `false` denies: a caller that forgot to look the address up on
  // the suppression list must not be told it may send.
  if (state.suppressed !== false) return { allow: false, reason: "suppressed" };
  if (state.accountClosed === true) return { allow: false, reason: "account_closed" };
  if (state.confirmed !== true && state.accountVerified !== true) {
    return { allow: false, reason: "not_confirmed" };
  }

  // A history entry that is not a finite number is treated as "sent just now": when in doubt,
  // count it against the caps rather than silently dropping it.
  const sent = state.lastMarketingSentAt.map((t) => (Number.isFinite(t) ? t : state.now));
  const inDay = sent.filter((t) => t > state.now - DAY_MS).sort((a, b) => a - b);
  if (inDay.length >= perDay) {
    const pivot = inDay[inDay.length - perDay] as number;
    return { allow: false, reason: "daily_cap", retryAt: pivot + DAY_MS };
  }
  const inMonth = sent.filter((t) => t > state.now - MONTH_MS).sort((a, b) => a - b);
  if (inMonth.length >= perMonth) {
    const pivot = inMonth[inMonth.length - perMonth] as number;
    return { allow: false, reason: "monthly_cap", retryAt: pivot + MONTH_MS };
  }
  return { allow: true, reason: "ok" };
}
