import { describe, it, expect } from "vitest";
import { createDohResolver, type DohFetch } from "../src/index.js";

type Reply = { Status: number; Answer?: unknown };

/** A fake DoH endpoint answering by record type, recording every URL asked. */
function fakeDoh(replies: Partial<Record<number, Reply>>) {
  const urls: string[] = [];
  const fetchFn: DohFetch = async (url) => {
    urls.push(url);
    const type = Number(new URL(url).searchParams.get("type"));
    return { ok: true, status: 200, json: async () => replies[type] ?? { Status: 0 } };
  };
  return { fetchFn, urls };
}

describe("createDohResolver", () => {
  it("returns MX exchanges, lowercased and without the trailing dot", async () => {
    const { fetchFn, urls } = fakeDoh({
      15: {
        Status: 0,
        Answer: [
          { type: 15, data: "10 MX1.Example.com." },
          { type: 15, data: "20 mx2.example.com." },
          { type: 5, data: "ignored.example.com." },
        ],
      },
    });
    const lookup = await createDohResolver({ fetch: fetchFn }).resolveMx("example.com");
    expect(lookup).toEqual({ kind: "records", exchanges: ["mx1.example.com", "mx2.example.com"] });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe("https://cloudflare-dns.com/dns-query?name=example.com&type=15");
  });

  it("keeps a null MX as a bare dot", async () => {
    const { fetchFn } = fakeDoh({ 15: { Status: 0, Answer: [{ type: 15, data: "0 ." }] } });
    expect(await createDohResolver({ fetch: fetchFn }).resolveMx("example.com")).toEqual({
      kind: "records",
      exchanges: ["."],
    });
  });

  it("reports NXDOMAIN", async () => {
    const { fetchFn } = fakeDoh({ 15: { Status: 3 } });
    expect(await createDohResolver({ fetch: fetchFn }).resolveMx("gone.example")).toEqual({
      kind: "nxdomain",
    });
  });

  it("treats SERVFAIL as an error, never as a missing domain", async () => {
    const { fetchFn } = fakeDoh({ 15: { Status: 2 } });
    const lookup = await createDohResolver({ fetch: fetchFn }).resolveMx("example.com");
    expect(lookup).toEqual({ kind: "error", message: "DNS rcode 2" });
  });

  it("falls back to an A record as an implicit MX", async () => {
    const { fetchFn, urls } = fakeDoh({
      1: { Status: 0, Answer: [{ type: 1, data: "192.0.2.1" }] },
    });
    expect(await createDohResolver({ fetch: fetchFn }).resolveMx("example.com")).toEqual({
      kind: "records",
      exchanges: ["example.com"],
    });
    expect(urls).toHaveLength(2);
  });

  it("falls back to an AAAA record when there is no A record", async () => {
    const { fetchFn } = fakeDoh({ 28: { Status: 0, Answer: [{ type: 28, data: "2001:db8::1" }] } });
    expect(await createDohResolver({ fetch: fetchFn }).resolveMx("example.com")).toEqual({
      kind: "records",
      exchanges: ["example.com"],
    });
  });

  it("returns no exchanges when nothing answers", async () => {
    const { fetchFn } = fakeDoh({});
    expect(await createDohResolver({ fetch: fetchFn }).resolveMx("example.com")).toEqual({
      kind: "records",
      exchanges: [],
    });
  });

  it("skips malformed answer entries", async () => {
    const { fetchFn } = fakeDoh({
      15: { Status: 0, Answer: [null, "x", { type: "15" }, { type: 15, data: "10" }] },
    });
    expect(await createDohResolver({ fetch: fetchFn }).resolveMx("example.com")).toEqual({
      kind: "records",
      exchanges: [],
    });
  });

  it("reports a non-200 response as an error", async () => {
    const fetchFn: DohFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const lookup = await createDohResolver({ fetch: fetchFn }).resolveMx("example.com");
    expect(lookup).toEqual({ kind: "error", message: "DNS-over-HTTPS endpoint returned HTTP 503" });
  });

  it.each([null, "text", { nope: true }])(
    "reports an unreadable body %j as an error",
    async (body) => {
      const fetchFn: DohFetch = async () => ({ ok: true, status: 200, json: async () => body });
      const lookup = await createDohResolver({ fetch: fetchFn }).resolveMx("example.com");
      expect(lookup.kind).toBe("error");
    },
  );

  it("reports a thrown fetch (network, timeout) as an error", async () => {
    const fetchFn: DohFetch = async () => {
      throw new Error("boom");
    };
    expect(await createDohResolver({ fetch: fetchFn }).resolveMx("example.com")).toEqual({
      kind: "error",
      message: "boom",
    });
    const stringThrower: DohFetch = async () => {
      throw "plain string";
    };
    expect(await createDohResolver({ fetch: stringThrower }).resolveMx("example.com")).toEqual({
      kind: "error",
      message: "plain string",
    });
  });

  it("uses a custom endpoint, sends the DoH accept header and a timeout signal", async () => {
    let seen: { url: string; accept: string | undefined; signal: AbortSignal } | undefined;
    const fetchFn: DohFetch = async (url, init) => {
      seen = { url, accept: init.headers.accept, signal: init.signal };
      return { ok: true, status: 200, json: async () => ({ Status: 3 }) };
    };
    await createDohResolver({
      fetch: fetchFn,
      endpoint: "https://dns.example/q",
      timeoutMs: 50,
    }).resolveMx("a.example");
    expect(seen?.url).toBe("https://dns.example/q?name=a.example&type=15");
    expect(seen?.accept).toBe("application/dns-json");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it("calls the platform fetch when none is injected", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ Status: 3 }),
    })) as unknown as typeof fetch;
    try {
      expect(await createDohResolver().resolveMx("a.example")).toEqual({ kind: "nxdomain" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
