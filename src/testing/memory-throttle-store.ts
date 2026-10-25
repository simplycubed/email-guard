import type { ThrottleCounter, ThrottleStore } from "../types.js";

/** In-memory `ThrottleStore` for tests. Not shared across isolates: never use in production. */
export function createMemoryThrottleStore(now: () => number = Date.now): ThrottleStore {
  const counters = new Map<string, ThrottleCounter>();

  function live(key: string): ThrottleCounter | null {
    const counter = counters.get(key);
    if (counter === undefined) return null;
    if (counter.expiresAt <= now()) {
      counters.delete(key);
      return null;
    }
    return counter;
  }

  return {
    get(key) {
      const counter = live(key);
      return Promise.resolve(counter === null ? null : { ...counter });
    },
    increment(key, ttlSeconds) {
      const existing = live(key);
      const next: ThrottleCounter = existing
        ? { count: existing.count + 1, expiresAt: existing.expiresAt }
        : { count: 1, expiresAt: now() + ttlSeconds * 1000 };
      counters.set(key, next);
      return Promise.resolve({ ...next });
    },
  };
}
