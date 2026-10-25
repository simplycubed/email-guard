import { describe, it, expect } from "vitest";
import {
  canSendMarketing,
  createDohResolver,
  createThrottle,
  isDisposableDomain,
  isSuppressed,
  normalizeAddress,
  signToken,
  suppress,
  verifyToken,
} from "../src/index.js";
// @ts-expect-error: JS module, no types.
import { scanLine } from "../scripts/no-leaks.mjs";
import { createMemorySuppressionStore, createMemoryThrottleStore } from "../src/testing/index.js";

const SECRET = "s".repeat(16) + "t".repeat(16) + "u".repeat(8);
const T0 = 1_800_000_000_000;
const NOW = T0;

describe("tokens: canonical MAC", () => {
  it("rejects a MAC whose spare trailing bits were flipped", async () => {
    const token = await signToken(
      { purpose: "confirm", address: "a@example.com", issuedAt: T0, ttlSeconds: 60 },
      SECRET,
    );
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = token[token.length - 1] as string;
    const idx = alphabet.indexOf(last);
    let accepted = 0;
    for (let k = 0; k < 64; k++) {
      if (k >> 4 !== idx >> 4 || k === idx) continue;
      const variant = token.slice(0, -1) + alphabet[k];
      const r = await verifyToken(variant, SECRET, { purpose: "confirm", now: T0 });
      if (r.valid) accepted++;
    }
    expect(accepted).toBe(0);
  });

  it.each(["a@example.com\r\nbcc: v@example.org", "a@b@example.com", "x@", "a b@example.com"])(
    "refuses to sign an address that is not mailbox-shaped: %j",
    async (address) => {
      await expect(
        signToken({ purpose: "confirm", address, ttlSeconds: 60 }, SECRET),
      ).rejects.toThrow(/not an email address/);
    },
  );
});

describe("suppression: normalization bypasses", () => {
  it("treats a trailing-dot domain as the same mailbox", async () => {
    const store = createMemorySuppressionStore();
    await suppress(store, { address: "User@Example.com", reason: "unsubscribe", source: "x" });
    expect(await isSuppressed(store, "user@example.com.")).toBe(true);
    expect(normalizeAddress("a@example.com..")).toBe("a@example.com");
  });

  it("does not fold plus tags", async () => {
    const store = createMemorySuppressionStore();
    await suppress(store, { address: "user@example.com", reason: "manual", source: "x" });
    expect(await isSuppressed(store, "user+tag@example.com")).toBe(false);
  });

  it.each(["a@example.com\r\nbcc: v@example.org", "a@example.com\u200b", "a\u0000@example.com"])(
    "refuses to record %j",
    async (address) => {
      await expect(
        suppress(createMemorySuppressionStore(), { address, reason: "manual", source: "x" }),
      ).rejects.toThrow(/not an email address/);
    },
  );
});

describe("canSendMarketing: fail closed", () => {
  const base = { confirmed: true, lastMarketingSentAt: [] as number[], now: NOW };

  it("denies when the suppression lookup was not supplied", () => {
    const state = base as unknown as Parameters<typeof canSendMarketing>[0];
    expect(canSendMarketing(state)).toEqual({ allow: false, reason: "suppressed" });
  });

  it("denies when suppressed is not a real boolean", () => {
    const state = { ...base, suppressed: "no" } as unknown as Parameters<
      typeof canSendMarketing
    >[0];
    expect(canSendMarketing(state).allow).toBe(false);
  });

  it("counts a non-finite history entry as a send just now", () => {
    const decision = canSendMarketing({ ...base, suppressed: false, lastMarketingSentAt: [NaN] });
    expect(decision).toEqual({ allow: false, reason: "daily_cap", retryAt: NOW + 86_400_000 });
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects the cap %s", (perDay) => {
    expect(() => canSendMarketing({ ...base, suppressed: false }, { perDay })).toThrow(/perDay/);
  });
});

describe("throttle: store and id hardening", () => {
  const rules = { r: { limit: 1, windowSeconds: 60 } };

  it("does not switch the limit off when the store clock disagrees with ours", async () => {
    const store = {
      get: () => Promise.resolve(null),
      increment: () => Promise.resolve({ count: 5, expiresAt: 1 }),
    };
    const result = await createThrottle(store, rules).consume("r", "x");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("rejects a store that returns a nonsense counter", async () => {
    const store = {
      get: () => Promise.resolve(null),
      increment: () => Promise.resolve({ count: 0, expiresAt: Date.now() + 1000 }),
    };
    await expect(createThrottle(store, rules).consume("r", "x")).rejects.toThrow(/invalid counter/);
  });

  it.each(["", "x".repeat(513)])("rejects an id of length %#", async (id) => {
    await expect(
      createThrottle(createMemoryThrottleStore(), rules).consume("r", id),
    ).rejects.toThrow(/throttle id/);
  });
});

describe("domain and DoH hardening", () => {
  it("returns quickly for an absurd label count", () => {
    const started = Date.now();
    expect(isDisposableDomain("a.".repeat(100_000) + "com")).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("refuses a non-https endpoint", () => {
    expect(() => createDohResolver({ endpoint: "http://127.0.0.1/dns" })).toThrow(/https/);
  });

  it("keeps an endpoint's own query string and escapes the name", async () => {
    const urls: string[] = [];
    const resolver = createDohResolver({
      endpoint: "https://resolver.example/q?ct=1",
      fetch: (url) => {
        urls.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ Status: 3 }),
        });
      },
    });
    await resolver.resolveMx("a.com&type=1#x");
    const parsed = new URL(urls[0] as string);
    expect(parsed.searchParams.get("ct")).toBe("1");
    expect(parsed.searchParams.get("name")).toBe("a.com&type=1#x");
    expect(parsed.searchParams.get("type")).toBe("15");
  });

  it("drops over-long exchanger names", async () => {
    const resolver = createDohResolver({
      fetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              Status: 0,
              Answer: [
                { type: 15, data: "10 " + "a".repeat(300) },
                { type: 15, data: "20 mx.example.com." },
              ],
            }),
        }),
    });
    expect(await resolver.resolveMx("example.com")).toEqual({
      kind: "records",
      exchanges: ["mx.example.com"],
    });
  });
});

describe("no-leaks: commit-SHA action pins", () => {
  const sha = "0123456789abcdef".repeat(3).slice(0, 40);
  it("allows a pinned `uses:` line", () => {
    expect(scanLine(`        uses: actions/checkout@${sha} # v6`)).toEqual([]);
  });
  it("still flags the same hex string anywhere else", () => {
    expect(scanLine(`token: ${sha}`)).toContain("long hex run");
  });
});
