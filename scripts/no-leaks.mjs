#!/usr/bin/env node
/**
 * NO-LEAKS — this package's publish-safety gate.
 *
 * The package is built to be public. Anything under the scan roots (the authored source,
 * the emitted dist, the README and package.json, which npm publishes regardless of the
 * `files` allowlist) must therefore carry no product name, no internal hostname, no
 * personal or company legal name, and nothing shaped like a secret. A leak here is
 * permanent once a version is published, so it is caught before the build is trusted.
 *
 * What is banned:
 *   - product names of the consumers this library serves;
 *   - the owner's personal name and legal-entity suffixes;
 *   - any mention of the owning organization's name or hostnames, EXCEPT the package
 *     scope (`@<org>/email-guard`) and the repository path, which are removed from each
 *     line before it is tested. The org name is allowed in the package name, LICENSE and
 *     AGENTS.md only; LICENSE and AGENTS.md are not scan roots;
 *   - secret-shaped strings: private key blocks, live payment keys, webhook secrets,
 *     cloud and registry tokens, and long hex or base64 runs.
 *
 * Self-reference defences: every pattern is ASSEMBLED AT RUNTIME from fragments so this
 * file holds no clean literal, and this file's own path is excluded regardless.
 * Never weaken a pattern to make a scan pass; remove the leak.
 *
 * Usage: node scripts/no-leaks.mjs [root ...]   (defaults to src dist README.md package.json)
 * Exits 0 clean, 1 on a hit. `scanForLeaks` and `scanLine` are imported by the vitest gate.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import process from "node:process";

const j = (...parts) => parts.join("");

// Product names, with an optional separator so spaced, hyphenated and joined spellings
// are all caught. Case-insensitive.
const PRODUCT = String.raw`\b(?:${["email", "vendor", "threat"].map((p) => `${p}[\\s_.-]?${j("wa", "tch")}`).join("|")})`;
const PERSON = String.raw`\b(?:${j("char", "les")}[\s_.-]?${j("gr", "een")}|${j("char", "les", "gr", "een")})`;
const ORG = j("simply", "cubed");

// What may remain of the organization name once removed from a line: the package scope
// and the repository path of this very package.
const ORG_ALLOWED = new RegExp(
  `@${ORG}/email-guard|github\\.com/${ORG}/email-guard|${ORG}/email-guard`,
  "gi",
);

// Case-insensitive name patterns.
const NAME_PATTERNS = [
  ["product name", new RegExp(PRODUCT, "i")],
  ["personal name", new RegExp(PERSON, "i")],
  ["legal-entity suffix", new RegExp(String.raw`\b${j("l", "lc")}\b`, "i")],
  ["organization or hostname", new RegExp(ORG, "i")],
  ["internal hostname", new RegExp(String.raw`\b[a-z0-9-]+\.(?:internal|corp)\b`, "i")],
];

// Legal-entity suffixes are only meaningful as whole capitalized or upper-case words, so
// "inc" inside ordinary prose ("inc rement") cannot match. Case-sensitive on purpose.
const ENTITY_CASE_SENSITIVE = new RegExp(
  String.raw`\b(?:${j("L", "LC")}|${j("G", "K")}|${j("K", "K")}|${j("Co", "rp")}|${j("I", "nc")}|${j("L", "td")})\b`,
);

const SECRET_PATTERNS = [
  ["private key block", new RegExp(String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`)],
  ["live payment key", new RegExp(String.raw`\b[sr]k_live_`, "i")],
  ["webhook signing secret", new RegExp(String.raw`\b${j("wh", "sec")}_`, "i")],
  ["cloud access key id", new RegExp(String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`)],
  ["source-host token", new RegExp(String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}`)],
  ["registry token", new RegExp(String.raw`\bnpm_[A-Za-z0-9]{30,}`)],
  ["long hex run", new RegExp(String.raw`\b[0-9a-fA-F]{32,}\b`)],
  [
    "long base64 run",
    new RegExp(
      String.raw`(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_-]*[A-Za-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_=-])`,
    ),
  ],
];

// Sourcemaps embed `sourcesContent` we do not author. The emitted `.js` and `.d.ts` are
// the shipped surface; explicit file roots (README, package.json) bypass this filter.
const SCAN_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"]);

// The scanner is the only exclusion: an exemption inside the roots is how a gate stops
// seeing real hits.
const EXCLUDE_PATH_FRAGMENTS = ["node_modules", j("scripts/no-", "leaks")];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (EXCLUDE_PATH_FRAGMENTS.some((f) => full.includes(f))) continue;
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (SCAN_EXTENSIONS.has(extname(full))) yield full;
  }
}

/**
 * Every file the given roots resolve to. A missing root is a HARD ERROR, not a skip:
 * `dist` only exists after `build`, and a tolerant scanner would report "clean" having
 * walked nothing at all.
 */
export function scanFiles(roots) {
  const files = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      throw new Error(
        `no-leaks: scan root does not exist: ${root} ` +
          `(build before scanning dist/ - a skipped root would pass vacuously)`,
      );
    }
    if (statSync(root).isDirectory()) files.push(...walk(root));
    else if (!EXCLUDE_PATH_FRAGMENTS.some((f) => root.includes(f))) files.push(root);
  }
  return files;
}

/** Test one line; returns the labels of every pattern it trips. */
export function scanLine(line) {
  const labels = [];
  const stripped = line.replace(ORG_ALLOWED, "");
  for (const [label, pattern] of NAME_PATTERNS) {
    if (pattern.test(stripped)) labels.push(label);
  }
  if (ENTITY_CASE_SENSITIVE.test(stripped) && !labels.includes("legal-entity suffix")) {
    labels.push("legal-entity suffix");
  }
  // A workflow step pinned to a full commit SHA (`uses: owner/repo@<40 hex>`) is the one
  // legitimate long hex string in the repository; blank only that token, not the line.
  const secretLine = line.replace(/(\buses:\s*[\w.-]+\/[\w./-]+@)[0-9a-f]{40}\b/, "$1");
  for (const [label, pattern] of SECRET_PATTERNS) {
    if (pattern.test(secretLine)) labels.push(label);
  }
  return labels;
}

/** Scan the given roots; return an array of { file, line, what, text } hits. */
export function scanForLeaks(roots) {
  const hits = [];
  for (const file of scanFiles(roots)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const what of scanLine(lines[i])) {
        // Never echo the matched text of a secret: the log would become the leak.
        const text = SECRET_PATTERNS.some(([label]) => label === what)
          ? "(redacted)"
          : lines[i].trim().slice(0, 120);
        hits.push({ file, line: i + 1, what, text });
      }
    }
  }
  return hits;
}

// CLI entrypoint.
// Everything a reader of the public repository or the npm tarball can see, except the
// LICENSE (which names the copyright holder) and the tests/scripts (which build their
// negative controls from fragments).
export const DEFAULT_ROOTS = [
  "src",
  "dist",
  "README.md",
  "package.json",
  "AGENTS.md",
  "CHANGELOG.md",
  "docs",
  ".github",
];

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const roots = process.argv.slice(2);
  const targets = roots.length > 0 ? roots : DEFAULT_ROOTS;
  let hits;
  let scanned;
  try {
    scanned = scanFiles(targets).length;
    hits = scanForLeaks(targets);
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (hits.length > 0) {
    console.error(`::error::no-leaks FAILED - ${hits.length} hit(s):`);
    for (const h of hits) console.error(`  ${h.file}:${h.line}  [${h.what}]  ${h.text}`);
    process.exit(1);
  }
  console.log(`no-leaks clean - ${scanned} file(s) across: ${targets.join(", ")}`);
}
