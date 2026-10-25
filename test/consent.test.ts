import { describe, it, expect } from "vitest";
import { canSendMarketing, type MarketingState } from "../src/index.js";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const D = 24 * H;

const lead: MarketingState = {
  confirmed: true,
  suppressed: false,
  lastMarketingSentAt: [],
  now: NOW,
};

describe("canSendMarketing: basis", () => {
  it("allows a confirmed lead with no history", () => {
    expect(canSendMarketing(lead)).toEqual({ allow: true, reason: "ok" });
  });

  it("allows a verified, open account that never double-opted-in", () => {
    const state = {
      confirmed: false,
      accountVerified: true,
      suppressed: false,
      lastMarketingSentAt: [],
      now: NOW,
    };
    expect(canSendMarketing(state)).toEqual({ allow: true, reason: "ok" });
  });

  it.each<[string, Partial<MarketingState>]>([
    ["nothing known", { confirmed: false }],
    ["an unverified account", { confirmed: false, accountVerified: false }],
  ])("denies %s", (_name, patch) => {
    expect(canSendMarketing({ ...lead, ...patch })).toEqual({
      allow: false,
      reason: "not_confirmed",
    });
  });

  it("never sends to a suppressed address, even a confirmed one", () => {
    expect(canSendMarketing({ ...lead, suppressed: true })).toEqual({
      allow: false,
      reason: "suppressed",
    });
  });

  it("never sends to a closed account, even a verified or confirmed one", () => {
    const closed = { ...lead, accountVerified: true, accountClosed: true };
    expect(canSendMarketing(closed)).toEqual({ allow: false, reason: "account_closed" });
  });

  it("checks suppression before closure", () => {
    expect(canSendMarketing({ ...lead, suppressed: true, accountClosed: true }).reason).toBe(
      "suppressed",
    );
  });

  it("rejects a non-numeric clock", () => {
    expect(() => canSendMarketing({ ...lead, now: Number.NaN })).toThrow(/state.now/);
  });
});

describe("canSendMarketing: caps", () => {
  it("defaults to one per 24 hours, with the time it clears", () => {
    const state = { ...lead, lastMarketingSentAt: [NOW - 2 * H] };
    expect(canSendMarketing(state)).toEqual({
      allow: false,
      reason: "daily_cap",
      retryAt: NOW - 2 * H + D,
    });
  });

  it("allows again once the last send is more than 24 hours old", () => {
    expect(canSendMarketing({ ...lead, lastMarketingSentAt: [NOW - D - 1] }).allow).toBe(true);
    expect(canSendMarketing({ ...lead, lastMarketingSentAt: [NOW - D] }).allow).toBe(true);
    expect(canSendMarketing({ ...lead, lastMarketingSentAt: [NOW - D + 1] }).allow).toBe(false);
  });

  it("counts a future timestamp as inside the window", () => {
    expect(canSendMarketing({ ...lead, lastMarketingSentAt: [NOW + H] }).reason).toBe("daily_cap");
  });

  it("enforces 12 per rolling 30 days by default", () => {
    const sends = Array.from({ length: 12 }, (_, i) => NOW - (i + 2) * 2 * D);
    const denied = canSendMarketing({ ...lead, lastMarketingSentAt: sends });
    expect(denied.allow).toBe(false);
    expect(denied.reason).toBe("monthly_cap");
    // The oldest of the last 12 sends frees the slot 30 days after it was sent.
    expect(denied).toMatchObject({ retryAt: Math.min(...sends) + 30 * D });
    expect(canSendMarketing({ ...lead, lastMarketingSentAt: sends.slice(1) }).allow).toBe(true);
  });

  it("honors custom caps", () => {
    const sends = [NOW - 2 * H, NOW - 3 * H];
    expect(canSendMarketing({ ...lead, lastMarketingSentAt: sends }, { perDay: 3 }).allow).toBe(
      true,
    );
    expect(canSendMarketing({ ...lead, lastMarketingSentAt: sends }, { perDay: 2 }).reason).toBe(
      "daily_cap",
    );
    const spread = [NOW - 2 * D, NOW - 3 * D, NOW - 4 * D];
    expect(canSendMarketing({ ...lead, lastMarketingSentAt: spread }, { perMonth: 3 }).reason).toBe(
      "monthly_cap",
    );
  });

  it("reports retryAt from the send that must age out, not the newest", () => {
    const sends = [NOW - 10 * H, NOW - 2 * H];
    const result = canSendMarketing({ ...lead, lastMarketingSentAt: sends }, { perDay: 2 });
    expect(result).toEqual({ allow: false, reason: "daily_cap", retryAt: NOW - 10 * H + D });
  });
});
