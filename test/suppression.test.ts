import { describe, it, expect } from "vitest";
import { isSuppressed, suppress } from "../src/index.js";
import { createMemorySuppressionStore } from "../src/testing/index.js";

describe("suppression", () => {
  it("normalizes on write and on read", async () => {
    const store = createMemorySuppressionStore();
    const entry = await suppress(store, {
      address: "  Person@Example.COM ",
      reason: "unsubscribe",
      source: " product-a ",
      now: 42,
    });
    expect(entry).toEqual({
      address: "person@example.com",
      reason: "unsubscribe",
      source: "product-a",
      addedAt: 42,
    });
    expect(await isSuppressed(store, "PERSON@example.com")).toBe(true);
    expect(await isSuppressed(store, "other@example.com")).toBe(false);
  });

  it("keeps the exact address: plus tags and gmail dots are different mailboxes", async () => {
    const store = createMemorySuppressionStore();
    await suppress(store, { address: "a.b+x@gmail.com", reason: "complaint", source: "p" });
    expect(await isSuppressed(store, "a.b+x@gmail.com")).toBe(true);
    expect(await isSuppressed(store, "a.b@gmail.com")).toBe(false);
    expect(await isSuppressed(store, "ab+x@gmail.com")).toBe(false);
  });

  it("is shared across sources and keeps the first recorded reason", async () => {
    const store = createMemorySuppressionStore();
    await suppress(store, { address: "a@example.com", reason: "hard_bounce", source: "product-a" });
    await suppress(store, { address: "a@example.com", reason: "manual", source: "product-b" });
    expect(store.entries()).toHaveLength(1);
    expect(store.entries()[0]).toMatchObject({ reason: "hard_bounce", source: "product-a" });
  });

  it("defaults addedAt to now", async () => {
    const before = Date.now();
    const entry = await suppress(createMemorySuppressionStore(), {
      address: "a@example.com",
      reason: "manual",
      source: "p",
    });
    expect(entry.addedAt).toBeGreaterThanOrEqual(before);
  });

  it.each(["", "plain", "@example.com", "a@", "a@b@c.com"])(
    "refuses to suppress %j",
    async (address) => {
      await expect(
        suppress(createMemorySuppressionStore(), { address, reason: "manual", source: "p" }),
      ).rejects.toThrow(/not an email address/);
    },
  );

  it("requires a source", async () => {
    await expect(
      suppress(createMemorySuppressionStore(), {
        address: "a@example.com",
        reason: "manual",
        source: "  ",
      }),
    ).rejects.toThrow(/needs a source/);
  });
});
