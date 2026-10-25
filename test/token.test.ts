import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "../src/index.js";

const SECRET_A = "a".repeat(16) + "B".repeat(16) + "-secret-one";
const SECRET_B = "z".repeat(16) + "Y".repeat(16) + "-secret-two";
const T0 = 1_800_000_000_000;

const base = { purpose: "confirm", address: "Person@Example.com", issuedAt: T0, ttlSeconds: 3600 };

describe("signToken / verifyToken", () => {
  it("round-trips and returns the normalized address", async () => {
    const token = await signToken(base, SECRET_A);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyToken(token, SECRET_A, { purpose: "confirm", now: T0 + 1000 })).toEqual({
      valid: true,
      purpose: "confirm",
      address: "person@example.com",
      issuedAt: T0,
      expiresAt: T0 + 3_600_000,
    });
  });

  it("defaults issuedAt and now to the current time", async () => {
    const token = await signToken(
      { purpose: "unsubscribe", address: "a@example.com", ttlSeconds: 60 },
      SECRET_A,
    );
    const result = await verifyToken(token, SECRET_A, { purpose: "unsubscribe" });
    expect(result.valid).toBe(true);
  });

  it("is deterministic for identical input", async () => {
    expect(await signToken(base, SECRET_A)).toBe(await signToken(base, SECRET_A));
  });

  describe("NEGATIVE CONTROLS (each failure mode fires)", () => {
    it("rejects the wrong secret", async () => {
      const token = await signToken(base, SECRET_A);
      expect(await verifyToken(token, SECRET_B, { purpose: "confirm", now: T0 })).toEqual({
        valid: false,
        reason: "bad_signature",
      });
    });

    it("rejects a tampered payload", async () => {
      const token = await signToken(base, SECRET_A);
      const [, mac] = token.split(".") as [string, string];
      const forged = btoa(
        JSON.stringify({ v: 1, p: "confirm", a: "victim@example.com", i: T0, e: T0 + 3_600_000 }),
      )
        .replace(/=+$/, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
      expect(
        await verifyToken(`${forged}.${mac}`, SECRET_A, { purpose: "confirm", now: T0 }),
      ).toEqual({
        valid: false,
        reason: "bad_signature",
      });
    });

    it("rejects a tampered signature", async () => {
      const token = await signToken(base, SECRET_A);
      const flipped = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
      const result = await verifyToken(flipped, SECRET_A, { purpose: "confirm", now: T0 });
      expect(result).toEqual({ valid: false, reason: "bad_signature" });
    });

    it("rejects a good token presented for another purpose", async () => {
      const token = await signToken(base, SECRET_A);
      expect(await verifyToken(token, SECRET_A, { purpose: "unsubscribe", now: T0 })).toEqual({
        valid: false,
        reason: "wrong_purpose",
      });
    });

    it("rejects an expired token, exactly at the boundary", async () => {
      const token = await signToken(base, SECRET_A);
      const justBefore = await verifyToken(token, SECRET_A, {
        purpose: "confirm",
        now: T0 + 3_599_999,
      });
      expect(justBefore.valid).toBe(true);
      const atExpiry = await verifyToken(token, SECRET_A, {
        purpose: "confirm",
        now: T0 + 3_600_000,
      });
      expect(atExpiry).toEqual({ valid: false, reason: "expired" });
    });

    it("rejects a token issued in the future beyond the skew allowance", async () => {
      const token = await signToken(base, SECRET_A);
      expect(await verifyToken(token, SECRET_A, { purpose: "confirm", now: T0 - 61_000 })).toEqual({
        valid: false,
        reason: "not_yet_valid",
      });
      const within = await verifyToken(token, SECRET_A, { purpose: "confirm", now: T0 - 30_000 });
      expect(within.valid).toBe(true);
      const strict = await verifyToken(token, SECRET_A, {
        purpose: "confirm",
        now: T0 - 30_000,
        clockSkewSeconds: 0,
      });
      expect(strict).toEqual({ valid: false, reason: "not_yet_valid" });
    });

    it.each(["", "no-dot", "a.b.c", "!!!.!!!", "abc.", ".abc", "YQ.YQ", "a".repeat(3000)])(
      "rejects malformed token %j",
      async (token) => {
        const result = await verifyToken(token, SECRET_A, { purpose: "confirm", now: T0 });
        expect(result).toEqual({ valid: false, reason: "malformed" });
      },
    );

    it("rejects a non-string token", async () => {
      const result = await verifyToken(undefined as unknown as string, SECRET_A, {
        purpose: "confirm",
      });
      expect(result).toEqual({ valid: false, reason: "malformed" });
    });
  });

  describe("signed but structurally wrong payloads are malformed, not trusted", () => {
    async function signRaw(body: string, secret: string): Promise<string> {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
      let bin = "";
      for (const b of mac) bin += String.fromCharCode(b);
      return `${body}.${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    }
    const b64 = (text: string) =>
      btoa(text).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

    it.each([
      ["not json", "{{{"],
      ["a json string", '"hi"'],
      ["null", "null"],
      ["wrong version", JSON.stringify({ v: 2, p: "confirm", a: "a@example.com", i: 1, e: 2 })],
      ["missing purpose", JSON.stringify({ v: 1, a: "a@example.com", i: 1, e: 2 })],
      [
        "non-numeric times",
        JSON.stringify({ v: 1, p: "confirm", a: "a@example.com", i: "1", e: "2" }),
      ],
    ])("%s", async (_name, json) => {
      const token = await signRaw(b64(json), SECRET_A);
      expect(await verifyToken(token, SECRET_A, { purpose: "confirm", now: T0 })).toEqual({
        valid: false,
        reason: "malformed",
      });
    });

    it("invalid UTF-8 inside a signed body", async () => {
      const token = await signRaw("_w", SECRET_A);
      expect(await verifyToken(token, SECRET_A, { purpose: "confirm", now: T0 })).toEqual({
        valid: false,
        reason: "malformed",
      });
    });

    it("a body that is not valid base64url", async () => {
      const token = await signRaw("A", SECRET_A);
      expect(await verifyToken(token, SECRET_A, { purpose: "confirm", now: T0 })).toEqual({
        valid: false,
        reason: "malformed",
      });
    });
  });

  describe("key rotation", () => {
    it("signs with the first secret and verifies against any", async () => {
      const oldToken = await signToken(base, SECRET_A);
      const newToken = await signToken(base, [SECRET_B, SECRET_A]);
      const opts = { purpose: "confirm", now: T0 } as const;
      expect((await verifyToken(oldToken, [SECRET_B, SECRET_A], opts)).valid).toBe(true);
      expect((await verifyToken(newToken, [SECRET_B, SECRET_A], opts)).valid).toBe(true);
      expect((await verifyToken(oldToken, [SECRET_B], opts)).valid).toBe(false);
      expect(newToken).toBe(await signToken(base, SECRET_B));
    });
  });

  describe("input validation", () => {
    it("refuses a short secret on both sides", async () => {
      await expect(signToken(base, "short")).rejects.toThrow(/at least 32/);
      await expect(verifyToken("a.b", "short", { purpose: "confirm" })).rejects.toThrow(
        /at least 32/,
      );
    });

    it("refuses empty secret lists", async () => {
      await expect(signToken(base, [])).rejects.toThrow(/no signing secret/);
      await expect(verifyToken("a.b", [], { purpose: "confirm" })).rejects.toThrow(
        /no verification secret/,
      );
    });

    it.each(["", "Confirm", "has space", "x".repeat(65), "-lead"])(
      "refuses purpose %j",
      async (purpose) => {
        await expect(signToken({ ...base, purpose }, SECRET_A)).rejects.toThrow(/purpose/);
        await expect(verifyToken("a.b", SECRET_A, { purpose })).rejects.toThrow(/purpose/);
      },
    );

    it.each([0, -5, 1.5, Number.NaN])("refuses ttlSeconds %s", async (ttlSeconds) => {
      await expect(signToken({ ...base, ttlSeconds }, SECRET_A)).rejects.toThrow(/ttlSeconds/);
    });

    it("refuses a ttl beyond the maximum", async () => {
      await expect(signToken({ ...base, ttlSeconds: 401 * 86400 }, SECRET_A)).rejects.toThrow(
        /maximum/,
      );
    });

    it.each(["", "   ", "no-at-sign"])("refuses address %j", async (address) => {
      await expect(signToken({ ...base, address }, SECRET_A)).rejects.toThrow(/email address/);
    });

    it.each([-1, 1.5])("refuses issuedAt %s", async (issuedAt) => {
      await expect(signToken({ ...base, issuedAt }, SECRET_A)).rejects.toThrow(/issuedAt/);
    });
  });
});
