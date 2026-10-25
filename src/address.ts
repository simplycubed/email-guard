import { DISPOSABLE_DOMAINS, ROLE_LOCAL_PARTS, TYPO_DOMAINS } from "./disposable-domains.js";
import { createDohResolver } from "./doh.js";
import { normalizeAddress, splitAddress } from "./normalize.js";
import type { AddressCheck, AddressReason, CheckAddressOptions } from "./types.js";

const LOCAL_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TLD_PATTERN = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const DISPOSABLE_SEED = new Set(DISPOSABLE_DOMAINS);
const ROLE_SET = new Set(ROLE_LOCAL_PARTS);

/**
 * Practical syntax check: one `@`, an ASCII dot-atom local part up to 64 characters, and a
 * multi-label domain with a letter-only (or punycode) TLD, up to 254 characters in all.
 * Internationalized domains must be supplied as punycode. Quoted local parts and IP
 * literals are rejected on purpose: nobody signs up for a newsletter with one.
 */
export function isValidSyntax(email: string): boolean {
  const normalized = normalizeAddress(email);
  if (normalized.length > 254) return false;
  const parts = splitAddress(normalized);
  if (parts === null || parts.local.length > 64 || !LOCAL_PATTERN.test(parts.local)) return false;
  if (parts.domain.length > 253) return false;
  const labels = parts.domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => label.length <= 63 && LABEL_PATTERN.test(label))) return false;
  return TLD_PATTERN.test(labels[labels.length - 1] as string);
}

/** True when `domain`, or any parent domain of it, is a known throwaway provider. */
export function isDisposableDomain(domain: string, extra?: Iterable<string>): boolean {
  // A name over 253 characters cannot be a registered domain, and the suffix walk below is
  // quadratic in the label count, so unbounded input would be a CPU sink.
  if (domain.length > 253) return false;
  const extras = extra ? new Set([...extra].map((d) => d.trim().toLowerCase())) : null;
  const labels = domain.trim().toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    if (DISPOSABLE_SEED.has(candidate) || extras?.has(candidate)) return true;
  }
  return false;
}

/** A corrected domain for a likely typo, or null. */
export function suggestDomain(domain: string): string | null {
  const lower = domain.trim().toLowerCase();
  const known = TYPO_DOMAINS[lower];
  if (known !== undefined) return known;
  // `.con`, `.cmo`, `.ocm` and `.vom` are not real TLDs and are near-certain typos of `.com`.
  const match = /^(.+)\.(?:con|cmo|ocm|vom)$/.exec(lower);
  return match ? `${match[1]}.com` : null;
}

/**
 * Layered address check, cheapest layer first:
 *   1. syntax            (invalid_syntax)
 *   2. typo suggestion   (typo_domain, risky)
 *   3. disposable domain (disposable_domain, invalid by default)
 *   4. role address      (role_address, risky)
 *   5. MX lookup         (domain_not_found, no_mx, null_mx: invalid; mx_lookup_failed: risky)
 *
 * Verdict: any invalid reason gives `invalid`, else any reason gives `risky`, else
 * `valid`. A valid verdict proves the address can receive mail, NOT that its owner asked
 * for it: that proof is a clicked confirm link (see `signToken`). There is no SMTP
 * mailbox probing here, by design: big providers answer every probe the same way, the
 * answers that do differ are unreliable, and probing from a sending network can get that
 * network flagged.
 */
export async function checkAddress(
  email: string,
  options: CheckAddressOptions = {},
): Promise<AddressCheck> {
  const address = normalizeAddress(email);
  if (!isValidSyntax(address)) {
    return { verdict: "invalid", reasons: ["invalid_syntax"], address };
  }

  const { local, domain } = splitAddress(address) as { local: string; domain: string };
  const invalid: AddressReason[] = [];
  const risky: AddressReason[] = [];
  let suggestion: string | undefined;

  const corrected = suggestDomain(domain);
  if (corrected !== null) {
    risky.push("typo_domain");
    suggestion = `${local}@${corrected}`;
  }

  if (isDisposableDomain(domain, options.extraDisposableDomains)) {
    (options.disposablePolicy === "risky" ? risky : invalid).push("disposable_domain");
  }

  if (ROLE_SET.has(local)) risky.push("role_address");

  // No point asking DNS about a domain already known to be a throwaway or a typo.
  if (!options.skipMx && invalid.length === 0 && corrected === null) {
    const resolver = options.resolver ?? createDohResolver();
    const lookup = await resolver.resolveMx(domain);
    if (lookup.kind === "nxdomain") {
      invalid.push("domain_not_found");
    } else if (lookup.kind === "error") {
      risky.push("mx_lookup_failed");
    } else if (lookup.exchanges.length === 0) {
      invalid.push("no_mx");
    } else if (lookup.exchanges.length === 1 && lookup.exchanges[0] === ".") {
      // RFC 7505 null MX: the domain states it accepts no mail.
      invalid.push("null_mx");
    }
  }

  const reasons = [...invalid, ...risky];
  const verdict = invalid.length > 0 ? "invalid" : risky.length > 0 ? "risky" : "valid";
  return suggestion === undefined
    ? { verdict, reasons, address }
    : { verdict, reasons, address, suggestion };
}
