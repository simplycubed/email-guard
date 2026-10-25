import type { SuppressionEntry, SuppressionStore } from "../types.js";

/** In-memory `SuppressionStore` for tests, with a peek at what was recorded. */
export interface MemorySuppressionStore extends SuppressionStore {
  entries(): SuppressionEntry[];
}

export function createMemorySuppressionStore(): MemorySuppressionStore {
  const byAddress = new Map<string, SuppressionEntry>();
  return {
    add(entry) {
      // First reason wins: a later duplicate must not rewrite why the address was suppressed.
      if (!byAddress.has(entry.address)) byAddress.set(entry.address, entry);
      return Promise.resolve();
    },
    has(address) {
      return Promise.resolve(byAddress.has(address));
    },
    entries() {
      return [...byAddress.values()];
    },
  };
}
