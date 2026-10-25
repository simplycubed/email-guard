import { isMailboxShaped, normalizeAddress } from "./normalize.js";
import type { TokenPayload, TokenResult, VerifyTokenOptions } from "./types.js";

const MIN_SECRET_LENGTH = 32;
const MAX_TOKEN_LENGTH = 2048;
const MAX_TTL_SECONDS = 400 * 24 * 60 * 60;
const PURPOSE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const DEFAULT_SKEW_SECONDS = 60;
const FORMAT_VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function assertSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`email-guard: token secrets must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function assertPurpose(purpose: string): void {
  if (!PURPOSE_PATTERN.test(purpose)) {
    throw new Error("email-guard: purpose must match /^[a-z0-9][a-z0-9_.:-]{0,63}$/");
  }
}

/**
 * Stateless signed token: `base64url(payload).base64url(HMAC-SHA256(payload))`, built on
 * Web Crypto so it runs on Workers and Node alike. There is no database row behind it, so
 * a double opt-in confirm link or an unsubscribe link costs no storage.
 *
 * Pass one secret, or an array for key rotation: the FIRST is used to sign, and
 * `verifyToken` accepts any of them. The address is normalized before signing. A token is
 * bearer proof of one purpose for one address until it expires, nothing more.
 */
export async function signToken(
  payload: TokenPayload,
  secret: string | readonly string[],
): Promise<string> {
  const signingSecret = typeof secret === "string" ? secret : secret[0];
  if (signingSecret === undefined) throw new Error("email-guard: no signing secret supplied");
  assertSecret(signingSecret);
  assertPurpose(payload.purpose);
  if (!Number.isInteger(payload.ttlSeconds) || payload.ttlSeconds <= 0) {
    throw new Error("email-guard: ttlSeconds must be a positive integer");
  }
  if (payload.ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error("email-guard: ttlSeconds exceeds the 400 day maximum");
  }
  const address = normalizeAddress(payload.address);
  if (!isMailboxShaped(address)) {
    throw new Error("email-guard: token address is not an email address");
  }
  const issuedAt = payload.issuedAt ?? Date.now();
  if (!Number.isInteger(issuedAt) || issuedAt < 0) {
    throw new Error("email-guard: issuedAt must be epoch milliseconds");
  }

  const body = toBase64Url(
    encoder.encode(
      JSON.stringify({
        v: FORMAT_VERSION,
        p: payload.purpose,
        a: address,
        i: issuedAt,
        e: issuedAt + payload.ttlSeconds * 1000,
      }),
    ),
  );
  const key = await hmacKey(signingSecret, "sign");
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return `${body}.${toBase64Url(mac)}`;
}

interface DecodedBody {
  p: string;
  a: string;
  i: number;
  e: number;
}

function decodeBody(body: string): DecodedBody | null {
  const bytes = fromBase64Url(body);
  if (bytes === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { v, p, a, i, e } = parsed as Record<string, unknown>;
  if (v !== FORMAT_VERSION) return null;
  if (typeof p !== "string" || typeof a !== "string") return null;
  if (typeof i !== "number" || typeof e !== "number") return null;
  return { p, a, i, e };
}

/**
 * Check a token. The signature is verified first and the payload is only trusted after.
 * Signature comparison is `crypto.subtle.verify`, which is constant time, and every
 * supplied secret is tried without early exit so rotation does not leak which key matched.
 * A token signed for another purpose fails with `wrong_purpose` even if the signature is
 * good, so a confirm link can never double as an unsubscribe link.
 */
export async function verifyToken(
  token: string,
  secret: string | readonly string[],
  options: VerifyTokenOptions,
): Promise<TokenResult> {
  const secrets = typeof secret === "string" ? [secret] : [...secret];
  if (secrets.length === 0) throw new Error("email-guard: no verification secret supplied");
  for (const s of secrets) assertSecret(s);
  assertPurpose(options.purpose);

  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { valid: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed" };
  const [body, mac] = parts as [string, string];
  const macBytes = fromBase64Url(mac);
  if (body.length === 0 || macBytes === null || macBytes.length !== 32) {
    return { valid: false, reason: "malformed" };
  }
  // Reject non-canonical base64url (spare trailing bits set): several strings would otherwise
  // decode to one MAC, so a consumer's "token already used" set keyed on the string could be
  // dodged by flipping the last character.
  if (toBase64Url(macBytes) !== mac) return { valid: false, reason: "malformed" };

  let matched = false;
  for (const s of secrets) {
    const key = await hmacKey(s, "verify");
    const ok = await crypto.subtle.verify("HMAC", key, macBytes, encoder.encode(body));
    matched = matched || ok;
  }
  if (!matched) return { valid: false, reason: "bad_signature" };

  const decoded = decodeBody(body);
  if (decoded === null) return { valid: false, reason: "malformed" };
  if (decoded.p !== options.purpose) return { valid: false, reason: "wrong_purpose" };

  const now = options.now ?? Date.now();
  const skewMs = (options.clockSkewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000;
  if (decoded.i - skewMs > now) return { valid: false, reason: "not_yet_valid" };
  if (now >= decoded.e) return { valid: false, reason: "expired" };

  return {
    valid: true,
    purpose: decoded.p,
    address: decoded.a,
    issuedAt: decoded.i,
    expiresAt: decoded.e,
  };
}
