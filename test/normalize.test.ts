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
