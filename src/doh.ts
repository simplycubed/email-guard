import type { DnsResolver, MxLookup } from "./types.js";

/** The slice of `fetch` the resolver needs. Structural, so Workers and Node both fit. */
export type DohFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface DohResolverOptions {
  /**
   * A DNS-over-HTTPS JSON endpoint, https only (anything else throws). Must be a fixed value
   * from your own config, never derived from user input.
   */
  endpoint?: string;
  /** Defaults to the platform `fetch`. Inject a fake in tests. */
  fetch?: DohFetch;
  /** Per-query timeout in milliseconds. Default 3000. */
  timeoutMs?: number;
}

const DEFAULT_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const TYPE_A = 1;
const TYPE_AAAA = 28;
const TYPE_MX = 15;
const RCODE_NOERROR = 0;
const RCODE_NXDOMAIN = 3;
// Hostile or broken resolvers: never process an unbounded answer set or hostname.
const MAX_ANSWERS = 64;
const MAX_HOST_LENGTH = 255;

interface DohAnswer {
  type: number;
  data: string;
}

interface DohReply {
  rcode: number;
  answers: DohAnswer[];
}

function parseReply(body: unknown): DohReply | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as { Status?: unknown; Answer?: unknown };
  if (typeof record.Status !== "number") return null;
  const answers: DohAnswer[] = [];
  if (Array.isArray(record.Answer)) {
    for (const item of record.Answer.slice(0, MAX_ANSWERS)) {
      if (typeof item !== "object" || item === null) continue;
      const { type, data } = item as { type?: unknown; data?: unknown };
      if (typeof type === "number" && typeof data === "string") answers.push({ type, data });
    }
  }
  return { rcode: record.Status, answers };
}

/**
 * MX lookups over DNS-over-HTTPS using only `fetch`, so it runs on Workers as is.
 *
 * A domain with no MX record but an address record is treated as accepting mail at
 * itself, which is the implicit-MX fallback in RFC 5321. A network failure, timeout or
 * unexpected reply is reported as `error`, never as `nxdomain`: a DNS hiccup must not
 * look like a nonexistent domain.
 */
export function createDohResolver(options: DohResolverOptions = {}): DnsResolver {
  const endpoint = new URL(options.endpoint ?? DEFAULT_ENDPOINT);
  if (endpoint.protocol !== "https:") {
    throw new Error("email-guard: the DNS-over-HTTPS endpoint must be an https URL");
  }
  const timeoutMs = options.timeoutMs ?? 3000;
  const doFetch: DohFetch = options.fetch ?? ((url, init) => fetch(url, init));

  async function query(name: string, type: number): Promise<DohReply> {
    const target = new URL(endpoint);
    target.searchParams.set("name", name);
    target.searchParams.set("type", String(type));
    const response = await doFetch(target.toString(), {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`DNS-over-HTTPS endpoint returned HTTP ${response.status}`);
    const reply = parseReply(await response.json());
    if (reply === null) throw new Error("DNS-over-HTTPS endpoint returned an unreadable reply");
    return reply;
  }

  return {
    async resolveMx(domain: string): Promise<MxLookup> {
      try {
        const mx = await query(domain, TYPE_MX);
        if (mx.rcode === RCODE_NXDOMAIN) return { kind: "nxdomain" };
        if (mx.rcode !== RCODE_NOERROR) return { kind: "error", message: `DNS rcode ${mx.rcode}` };

        const exchanges = mx.answers
          .filter((a) => a.type === TYPE_MX)
          .map((a) => a.data.trim().split(/\s+/)[1])
          .filter(
            (host): host is string =>
              typeof host === "string" && host.length > 0 && host.length <= MAX_HOST_LENGTH,
          )
          .map((host) => (host === "." ? host : host.replace(/\.$/, "").toLowerCase()));
        if (exchanges.length > 0) return { kind: "records", exchanges };

        for (const type of [TYPE_A, TYPE_AAAA]) {
          const addr = await query(domain, type);
          if (addr.answers.some((a) => a.type === type)) {
            return { kind: "records", exchanges: [domain] };
          }
        }
        return { kind: "records", exchanges: [] };
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
