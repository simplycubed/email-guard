import { describe, it, expect } from "vitest";
import { createThrottle } from "../src/index.js";
import { createMemoryThrottleStore } from "../src/testing/index.js";

function setup(
  rules = { address: { limit: 2, windowSeconds: 60 }, ip: { limit: 3, windowSeconds: 600 } },
) {
  let now = 1_800_000_000_000;
  const clock = () => now;
  const store = createMemoryThrottleStore(clock);
  const throttle = createThrottle(store, rules, { now: clock });
  return { throttle, store, advance: (ms: number) => (now += ms) };
}

describe("createThrottle", () => {
  it("allows up to the limit, then refuses with a retry time", async () => {
    const { throttle, advance } = setup();
    expect(await throttle.consume("address", "a@example.com")).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 0,
    });
    expect(await throttle.consume("address", "a@example.com")).toEqual({
      allowed: true,
      remaining: 0,
      retryAfterSeconds: 0,
    });
    advance(10_000);
    expect(await throttle.consume("address", "a@example.com")).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 50,
    });
  });

  it("keeps counting refused attempts, so the window cannot be reset by hammering", async () => {
    const { throttle, advance } = setup();
    for (let i = 0; i < 5; i++) await throttle.consume("address", "a@example.com");
    advance(59_000);
    expect((await throttle.consume("address", "a@example.com")).allowed).toBe(false);
    advance(1_000);
    expect(await throttle.consume("address", "a@example.com")).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 0,
    });
  });

  it("isolates ids and rules from each other", async () => {
    const { throttle } = setup();
    await throttle.consume("address", "a@example.com");
    await throttle.consume("address", "a@example.com");
    expect((await throttle.consume("address", "b@example.com")).allowed).toBe(true);
    expect((await throttle.consume("ip", "a@example.com")).allowed).toBe(true);
  });

  it("peek reads without counting", async () => {
    const { throttle } = setup();
    expect(await throttle.peek("address", "a@example.com")).toEqual({
      allowed: true,
      remaining: 2,
      retryAfterSeconds: 0,
    });
    await throttle.consume("address", "a@example.com");
    await throttle.consume("address", "a@example.com");
    await throttle.consume("address", "a@example.com");
    const peeked = await throttle.peek("address", "a@example.com");
    expect(peeked).toMatchObject({ allowed: false, remaining: 0 });
    expect(peeked.retryAfterSeconds).toBe(60);
    expect((await throttle.peek("address", "a@example.com")).retryAfterSeconds).toBe(60);
  });

  it("treats an expired counter as fresh", async () => {
    const { throttle, advance } = setup();
    await throttle.consume("address", "a@example.com");
    advance(61_000);
    expect(await throttle.peek("address", "a@example.com")).toEqual({
      allowed: true,
      remaining: 2,
      retryAfterSeconds: 0,
    });
  });

  it("never reports a zero retry for a refused attempt", async () => {
    const { throttle, advance } = setup();
    for (let i = 0; i < 3; i++) await throttle.consume("address", "a@example.com");
    advance(59_999);
    expect((await throttle.consume("address", "a@example.com")).retryAfterSeconds).toBe(1);
  });

  describe("consumeAll", () => {
    it("is allowed only when every rule allows, and reports the worst case", async () => {
      const { throttle } = setup();
      const pairs = [
        ["address", "a@example.com"],
        ["ip", "203.0.113.9"],
      ] as const;
      expect(await throttle.consumeAll(pairs)).toEqual({
        allowed: true,
        remaining: 1,
        retryAfterSeconds: 0,
      });
      await throttle.consumeAll(pairs);
      const third = await throttle.consumeAll(pairs);
      expect(third).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
      // The address rule is exhausted although the IP rule still has room.
      expect((await throttle.peek("ip", "203.0.113.9")).allowed).toBe(true);
    });

    it("needs at least one pair", async () => {
      await expect(setup().throttle.consumeAll([])).rejects.toThrow(/at least one/);
    });
  });

  describe("configuration errors", () => {
    it("rejects an unknown rule, including inherited names", async () => {
      const { throttle } = setup();
      await expect(throttle.consume("nope", "x")).rejects.toThrow(/unknown throttle rule/);
      await expect(throttle.peek("toString", "x")).rejects.toThrow(/unknown throttle rule/);
    });

    it.each([
      { limit: 0, windowSeconds: 60 },
      { limit: 1.5, windowSeconds: 60 },
      { limit: 1, windowSeconds: 0 },
      { limit: 1, windowSeconds: 0.5 },
    ])("rejects bad rule %j at creation", (rule) => {
      expect(() => createThrottle(createMemoryThrottleStore(), { r: rule })).toThrow(
        /needs integer/,
      );
    });
  });

  it("defaults to the system clock", async () => {
    const throttle = createThrottle(createMemoryThrottleStore(), {
      r: { limit: 1, windowSeconds: 60 },
    });
    expect((await throttle.consume("r", "x")).allowed).toBe(true);
    expect((await throttle.consume("r", "x")).allowed).toBe(false);
  });
});
