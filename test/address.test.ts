import { describe, it, expect } from "vitest";
import { checkAddress, isDisposableDomain, isValidSyntax, suggestDomain } from "../src/index.js";
import { createFakeResolver } from "../src/testing/index.js";

const live = { kind: "records", exchanges: ["mx.example.com"] } as const;

describe("isValidSyntax", () => {
  it.each([
    "a@example.com",
    "first.last@sub.example.co.uk",
    "a+tag@example.com",
    "o'brien@example.org",
    "x@xn--bcher-kva.example",
    "UPPER@EXAMPLE.COM",
  ])("accepts %s", (email) => {
    expect(isValidSyntax(email)).toBe(true);
  });

  it.each([
    "",
    "plain",
    "a@b",
    "a@@example.com",
    "@example.com",
    "a@example..com",
    "a..b@example.com",
    ".a@example.com",
    "a.@example.com",
    "a b@example.com",
    "a@-example.com",
    "a@example-.com",
    "a@example.c",
    "a@example.123",
    "a@[127.0.0.1]",
    '"quoted"@example.com',
    "bücher@example.com",
    "a@bücher.example",
    `${"a".repeat(65)}@example.com`,
    `a@${"b".repeat(64)}.example.com`,
    `a@${"b.".repeat(130)}com`,
    `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(40)}.com`,
  ])("rejects %j", (email) => {
    expect(isValidSyntax(email)).toBe(false);
  });
});

describe("isDisposableDomain", () => {
  it("matches the seed list and subdomains of it", () => {
    expect(isDisposableDomain("mailinator.com")).toBe(true);
    expect(isDisposableDomain("Inbox.Mailinator.com")).toBe(true);
  });

  it("does not match an unrelated or merely similar domain", () => {
    expect(isDisposableDomain("example.com")).toBe(false);
    expect(isDisposableDomain("notmailinator.com")).toBe(false);
    expect(isDisposableDomain("com")).toBe(false);
  });

  it("honors extra domains", () => {
    expect(isDisposableDomain("burner.example")).toBe(false);
    expect(isDisposableDomain("mail.burner.example", [" Burner.Example "])).toBe(true);
  });
});

describe("suggestDomain", () => {
  it.each([
    ["gmial.com", "gmail.com"],
    ["GMAIL.CON", "gmail.com"],
    ["example.con", "example.com"],
    ["example.cmo", "example.com"],
  ])("fixes %s", (input, expected) => {
    expect(suggestDomain(input)).toBe(expected);
  });

  it("leaves a correct domain alone", () => {
    expect(suggestDomain("gmail.com")).toBeNull();
    expect(suggestDomain("example.org")).toBeNull();
  });
});

describe("checkAddress", () => {
  it("is valid for a clean address on a domain with MX records", async () => {
    const resolver = createFakeResolver({ "example.com": live });
    expect(await checkAddress(" Person@Example.com ", { resolver })).toEqual({
      verdict: "valid",
      reasons: [],
      address: "person@example.com",
    });
    expect(resolver.calls).toEqual(["example.com"]);
  });

  it("is invalid on bad syntax and never touches DNS", async () => {
    const resolver = createFakeResolver();
    const result = await checkAddress("not-an-email", { resolver });
    expect(result).toEqual({
      verdict: "invalid",
      reasons: ["invalid_syntax"],
      address: "not-an-email",
    });
    expect(resolver.calls).toEqual([]);
  });

  it("is invalid when the domain does not exist", async () => {
    const result = await checkAddress("a@missing.example", { resolver: createFakeResolver() });
    expect(result.verdict).toBe("invalid");
    expect(result.reasons).toEqual(["domain_not_found"]);
  });

  it("is invalid when the domain takes no mail", async () => {
    const resolver = createFakeResolver({ "example.com": { kind: "records", exchanges: [] } });
    expect((await checkAddress("a@example.com", { resolver })).reasons).toEqual(["no_mx"]);
  });

  it("is invalid on a null MX", async () => {
    const resolver = createFakeResolver({ "example.com": { kind: "records", exchanges: ["."] } });
    const result = await checkAddress("a@example.com", { resolver });
    expect(result.verdict).toBe("invalid");
    expect(result.reasons).toEqual(["null_mx"]);
  });

  it("is only risky when DNS fails, because a hiccup is not a bad address", async () => {
    const resolver = createFakeResolver({ "example.com": { kind: "error", message: "timeout" } });
    const result = await checkAddress("a@example.com", { resolver });
    expect(result.verdict).toBe("risky");
    expect(result.reasons).toEqual(["mx_lookup_failed"]);
  });

  it("rejects disposable domains by default, without a DNS query", async () => {
    const resolver = createFakeResolver({ "mailinator.com": live });
    const result = await checkAddress("a@mailinator.com", { resolver });
    expect(result.verdict).toBe("invalid");
    expect(result.reasons).toEqual(["disposable_domain"]);
    expect(resolver.calls).toEqual([]);
  });

  it("can downgrade disposable to risky", async () => {
    const resolver = createFakeResolver({ "mailinator.com": live });
    const result = await checkAddress("a@mailinator.com", {
      resolver,
      disposablePolicy: "risky",
    });
    expect(result.verdict).toBe("risky");
    expect(result.reasons).toEqual(["disposable_domain"]);
  });

  it("uses extraDisposableDomains", async () => {
    const result = await checkAddress("a@burner.example", {
      skipMx: true,
      extraDisposableDomains: ["burner.example"],
    });
    expect(result.reasons).toEqual(["disposable_domain"]);
  });

  it("flags a typo with a suggestion and skips DNS for it", async () => {
    const resolver = createFakeResolver();
    const result = await checkAddress("Sam@gmial.com", { resolver });
    expect(result).toEqual({
      verdict: "risky",
      reasons: ["typo_domain"],
      address: "sam@gmial.com",
      suggestion: "sam@gmail.com",
    });
    expect(resolver.calls).toEqual([]);
  });

  it("flags role addresses as risky", async () => {
    const resolver = createFakeResolver({ "example.com": live });
    const result = await checkAddress("info@example.com", { resolver });
    expect(result.verdict).toBe("risky");
    expect(result.reasons).toEqual(["role_address"]);
  });

  it("orders invalid reasons before risky ones", async () => {
    const result = await checkAddress("info@mailinator.com", { skipMx: true });
    expect(result.verdict).toBe("invalid");
    expect(result.reasons).toEqual(["disposable_domain", "role_address"]);
  });

  it("skips the MX layer on request", async () => {
    const resolver = createFakeResolver();
    const result = await checkAddress("a@example.com", { resolver, skipMx: true });
    expect(result.verdict).toBe("valid");
    expect(resolver.calls).toEqual([]);
  });

  it("falls back to the DoH resolver when none is injected", async () => {
    const realFetch = globalThis.fetch;
    let asked = "";
    globalThis.fetch = (async (url: string) => {
      asked = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ Status: 0, Answer: [{ type: 15, data: "10 mx.example.com." }] }),
      };
    }) as unknown as typeof fetch;
    try {
      const result = await checkAddress("a@example.com");
      expect(result.verdict).toBe("valid");
      expect(asked).toContain("name=example.com");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
