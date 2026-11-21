import { describe, it, expect } from "vitest";
import { normalizeAddress, splitAddress } from "../src/index.js";

describe("normalizeAddress", () => {
  it.each([
    ["  A@Example.COM ", "a@example.com"],
    ["User.Name@Example.com", "user.name@example.com"],
    ["a@example.com", "a@example.com"],
  ])("trims and lowercases %j", (input, expected) => {
    expect(normalizeAddress(input)).toBe(expected);
  });

  it("does NOT strip plus tags", () => {
    expect(normalizeAddress("a+news@example.com")).toBe("a+news@example.com");
  });

  it("does NOT apply provider dot rules", () => {
    expect(normalizeAddress("a.b@gmail.com")).toBe("a.b@gmail.com");
    expect(normalizeAddress("a.b@gmail.com")).not.toBe(normalizeAddress("ab@gmail.com"));
  });

  it.each([
    ["a@example.com.", "a@example.com"],
    ["a@example.com...", "a@example.com"],
    ["a@example..com.", "a@example..com"],
    ["a@...", "a@"],
    ["a@.", "a@"],
    ["a@", "a@"],
    ["noat...", "noat..."],
  ])("drops only the trailing dot run on the domain: %j", (input, expected) => {
    expect(normalizeAddress(input)).toBe(expected);
  });

  // Regression guard for the polynomial regex this function used to carry
  // (CodeQL js/polynomial-redos, src/normalize.ts). `a@` + `.`*n + `x` is the
  // pathological shape: the old /\.+$/ matched the dot run from every offset,
  // failed `$`, and backtracked, costing O(n^2). At n=64000 that measured 1.8s,
  // which alone exceeds a default Cloudflare Workers CPU budget many times over.
  // The replacement is a single backward scan. The bound below sits ~9x under the
  // old timing and four orders of magnitude above the new one, so it fails loudly
  // if the regex ever comes back and does not flake on a slow runner.
  it("normalizes a long trailing dot run in linear time", () => {
    const attack = "a@" + ".".repeat(64_000) + "x";
    const started = performance.now();
    expect(normalizeAddress(attack)).toBe(attack);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("splitAddress", () => {
  it("splits a normalized address", () => {
    expect(splitAddress(" Me@Example.com")).toEqual({ local: "me", domain: "example.com" });
  });

  it.each(["", "no-at-sign", "@example.com", "me@", "a@b@example.com"])(
    "returns null for %j",
    (input) => {
      expect(splitAddress(input)).toBeNull();
    },
  );
});
