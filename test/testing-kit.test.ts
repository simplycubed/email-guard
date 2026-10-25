import { describe, it, expect } from "vitest";
import { createFakeResolver, createMemoryThrottleStore } from "../src/testing/index.js";

describe("test kit", () => {
  it("fake resolver answers from its table, nxdomain otherwise, and records calls", async () => {
    const resolver = createFakeResolver({
      "a.example": { kind: "records", exchanges: ["mx.a.example"] },
    });
    expect(await resolver.resolveMx("a.example")).toEqual({
      kind: "records",
      exchanges: ["mx.a.example"],
    });
    expect(await resolver.resolveMx("b.example")).toEqual({ kind: "nxdomain" });
    expect(resolver.calls).toEqual(["a.example", "b.example"]);
    expect(await createFakeResolver().resolveMx("x.example")).toEqual({ kind: "nxdomain" });
  });

  it("memory throttle store returns copies, not live counters", async () => {
    const store = createMemoryThrottleStore();
    const first = await store.increment("k", 60);
    first.count = 99;
    expect((await store.get("k"))?.count).toBe(1);
    expect(await store.get("missing")).toBeNull();
  });

  it("memory throttle store expires counters on its clock", async () => {
    let now = 0;
    const store = createMemoryThrottleStore(() => now);
    await store.increment("k", 1);
    now = 1000;
    expect(await store.get("k")).toBeNull();
    expect((await store.increment("k", 1)).count).toBe(1);
  });
});
