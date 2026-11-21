/**
 * The one shared address normalizer. Every module that keys on an address (suppression,
 * throttle keys, signed tokens) goes through this function, so two spellings of the same
 * mailbox can never be tracked as two people.
 *
 * Decision: trim, lowercase, and drop trailing dots from the domain part. Nothing else.
 *  - A trailing dot on a domain (`a@example.com.`) is the DNS root label: the same host.
 *    Dropping it stops `a@example.com.` from slipping past a suppression entry.
 *  - Plus-addressing (`a+tag@example.com`) is NOT stripped.
 *  - Provider-specific dot rules (`a.b@gmail.com` equals `ab@gmail.com`) are NOT applied.
 * Both folds are provider-specific guesses. Applying them would let an unsubscribe for one
 * mailbox silence a different real one, and keeping the exact address is the conservative
 * choice for a library whose job is to avoid mailing the wrong person. A consumer that
 * wants a fold can apply it before calling in.
 *
 * Always mail the NORMALIZED address (`AddressCheck.address`), never the raw input: lowercasing
 * folds a few non-ASCII characters (for example the Kelvin sign) onto ASCII letters.
 */
export function normalizeAddress(email: string): string {
  const lowered = email.trim().toLowerCase();
  const at = lowered.indexOf("@");
  if (at < 0) return lowered;
  // Scan back over the trailing dot run instead of matching /\.+$/ on the domain.
  // That regex is polynomial: on a domain of n dots followed by any non-dot, `\.+`
  // matches greedily from every start offset, fails `$`, and backtracks the whole
  // run, so the work is O(n^2). Measured on the old code, `a@` + `.`*n + `x` took
  // 28ms at n=8000 and 1.8s at n=64000. normalizeAddress is exported, takes
  // consumer input, and caps nothing (the 254 limit in isMailboxShaped applies to
  // its OUTPUT), so a caller passing an untrusted string could burn a Workers CPU
  // budget on a few kilobytes. This loop is a single backward pass, and the 46 is
  // ".". Behaviour is unchanged: a domain that is all dots still collapses to
  // everything up to and including the "@".
  let end = lowered.length;
  while (end > at + 1 && lowered.charCodeAt(end - 1) === 46) end--;
  return lowered.slice(0, end);
}

/** The two halves of a normalized address, or null when it has no single `@` to split on. */
export function splitAddress(email: string): { local: string; domain: string } | null {
  const normalized = normalizeAddress(email);
  const at = normalized.indexOf("@");
  if (at <= 0 || at !== normalized.lastIndexOf("@") || at === normalized.length - 1) return null;
  return { local: normalized.slice(0, at), domain: normalized.slice(at + 1) };
}

// Whitespace, C0/C1 controls, line separators and zero-width characters. None can appear in
// an address that is safe to put in a header, a token or a store key.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_CHARS = /[\u0000-\u0020\u007f-\u009f\u00a0\u2028\u2029\u200b-\u200f\u2060\ufeff]/;

/**
 * Internal guard for `signToken` and `suppress`, which accept any address a consumer has
 * (including ones `checkAddress` would reject): exactly one `@`, both halves non-empty,
 * at most 254 characters, and no whitespace, control or zero-width characters (CR and LF
 * would be a header-injection vector in any mailer that trusted the value). Not exported
 * from the package barrel.
 */
export function isMailboxShaped(normalized: string): boolean {
  return (
    normalized.length <= 254 && !UNSAFE_CHARS.test(normalized) && splitAddress(normalized) !== null
  );
}
