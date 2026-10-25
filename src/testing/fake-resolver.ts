import type { DnsResolver, MxLookup } from "../types.js";

export interface FakeResolver extends DnsResolver {
  /** Domains looked up, in order. */
  readonly calls: string[];
}

/**
 * A `DnsResolver` answering from a fixed table. A domain missing from the table is
 * `nxdomain`, so a test only lists the domains it wants to exist.
 */
export function createFakeResolver(table: Readonly<Record<string, MxLookup>> = {}): FakeResolver {
  const calls: string[] = [];
  return {
    calls,
    resolveMx(domain) {
      calls.push(domain);
      return Promise.resolve(table[domain] ?? { kind: "nxdomain" });
    },
  };
}
