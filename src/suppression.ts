import { isMailboxShaped, normalizeAddress } from "./normalize.js";
import type { SuppressionEntry, SuppressionReason, SuppressionStore } from "./types.js";

export interface SuppressInput {
  address: string;
  reason: SuppressionReason;
  /** Which product or system recorded it. */
  source: string;
  /** Epoch milliseconds. Defaults to now. */
  now?: number;
}

/**
 * Record that an address must not be mailed. The address is normalized first (trim and
 * lowercase only, see `normalizeAddress`), so `A@Example.com ` and `a@example.com` are one
 * entry. Suppression is meant to be SHARED across products: an unsubscribe in one product
 * silences all of them.
 */
export async function suppress(
  store: SuppressionStore,
  input: SuppressInput,
): Promise<SuppressionEntry> {
  const address = normalizeAddress(input.address);
  if (!isMailboxShaped(address)) {
    throw new Error("email-guard: cannot suppress a value that is not an email address");
  }
  if (input.source.trim().length === 0) throw new Error("email-guard: suppression needs a source");
  const entry: SuppressionEntry = {
    address,
    reason: input.reason,
    source: input.source.trim(),
    addedAt: input.now ?? Date.now(),
  };
  await store.add(entry);
  return entry;
}

/** True when the normalized address is on the list. */
export function isSuppressed(store: SuppressionStore, address: string): Promise<boolean> {
  return store.has(normalizeAddress(address));
}
