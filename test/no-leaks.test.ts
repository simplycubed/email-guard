/**
 * THE LEAK GATE, WATCHED FIRING.
 *
 * Asserts the authored source carries no product name, personal or entity name, or
 * secret-shaped string, and proves the scanner CAN go red. A scan nobody has seen fail is
 * a false clear, so each category is exercised against a planted fixture, along with the
 * allowed-scope carve-out and the vacuous-pass hole (a root that does not exist).
 *
 * Every planted value is assembled at runtime from fragments, so this file holds no clean
 * literal of its own and cannot trip a secret scanner on the repository.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
// @ts-expect-error: JS module, no types; exports scanForLeaks, scanFiles, scanLine.
import { scanForLeaks, scanFiles, scanLine } from "../scripts/no-leaks.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const j = (...parts: string[]) => parts.join("");

function withPlantedFile(content: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "leaks-"));
  try {
    writeFileSync(join(dir, "planted.ts"), content);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("no-leaks: the shipped source is clean", () => {
  it("finds no leak in src/, README.md or package.json", () => {
    const roots = [
      join(repoRoot, "src"),
      join(repoRoot, "README.md"),
      join(repoRoot, "package.json"),
    ];
    const hits = scanForLeaks(roots);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });

  it("actually walks a non-trivial number of files", () => {
    expect(scanFiles([join(repoRoot, "src")]).length).toBeGreaterThan(8);
  });
});

describe("no-leaks: NEGATIVE CONTROL (the scanner can go red)", () => {
  it.each([
    j("Email", " Wa", "tch"),
    j("email", "wa", "tch"),
    j("vendor", "-wa", "tch"),
    j("Vendor", " Wa", "tch"),
    j("threat", "_wa", "tch"),
    j("Threat", "Wa", "tch"),
  ])("flags the product name %j", (planted) => {
    expect(scanLine(`// built for ${planted}`)).toContain("product name");
    withPlantedFile(`export const note = "${planted}";\n`, (dir) => {
      expect(scanForLeaks([dir]).length).toBeGreaterThan(0);
    });
  });

  it("flags the owner's personal name in either spelling", () => {
    expect(scanLine(j("Char", "les Gr", "een"))).toContain("personal name");
    expect(scanLine(j("char", "les", "gr", "een"))).toContain("personal name");
  });

  it("flags legal-entity suffixes", () => {
    expect(scanLine(`owned by ${j("L", "LC")}`)).toContain("legal-entity suffix");
    expect(scanLine(`owned by ${j("l", "lc")}`)).toContain("legal-entity suffix");
    expect(scanLine(`${j("Co", "rp")} and ${j("G", "K")}`)).toContain("legal-entity suffix");
  });

  it("flags the organization name and its hostnames anywhere but the package scope", () => {
    const org = j("simply", "cubed");
    expect(scanLine(`see ${org}.com/internal`)).toContain("organization or hostname");
    expect(scanLine(`https://api.${org}.dev`)).toContain("organization or hostname");
    expect(scanLine(`// by ${j("Simply", "Cubed")}`)).toContain("organization or hostname");
    expect(scanLine("db.prod.internal")).toContain("internal hostname");
    withPlantedFile(`const host = "${org}.com";\n`, (dir) => {
      expect(scanForLeaks([dir]).length).toBeGreaterThan(0);
    });
  });

  it("ALLOWS the organization name only in the package scope and repository path", () => {
    const org = j("simply", "cubed");
    expect(scanLine(`pnpm add @${org}/email-guard`)).toEqual([]);
    expect(scanLine(`"name": "@${org}/email-guard",`)).toEqual([]);
    expect(scanLine(`"url": "git+https://github.com/${org}/email-guard.git"`)).toEqual([]);
    // The carve-out is exact: another package under the same scope still trips it.
    expect(scanLine(`@${org}/something-else`)).toContain("organization or hostname");
  });

  it.each([
    ["private key block", j("-----BEGIN RSA ", "PRIVATE KEY-----")],
    ["live payment key", j("sk", "_live_", "x")],
    ["webhook signing secret", j("wh", "sec_", "x")],
    ["cloud access key id", j("AK", "IA", "ABCDEFGHIJKLMNOP")],
    ["source-host token", j("gh", "p_", "a".repeat(36))],
    ["registry token", j("np", "m_", "b".repeat(36))],
    ["long hex run", "0123456789abcdef".repeat(2)],
    ["long base64 run", "Zm9vYmFy1234".repeat(4)],
  ])("flags a planted %s", (label, planted) => {
    expect(scanLine(`const x = "${planted}";`)).toContain(label);
    withPlantedFile(`export const x = "${planted}";\n`, (dir) => {
      expect(scanForLeaks([dir]).length).toBeGreaterThan(0);
    });
  });

  it("never echoes a matched secret into its report", () => {
    const planted = j("sk", "_live_", "x");
    withPlantedFile(`export const x = "${planted}";\n`, (dir) => {
      const [hit] = scanForLeaks([dir]);
      expect(JSON.stringify(hit)).not.toContain(planted);
    });
  });

  it("does NOT flag ordinary prose, short hashes, import paths or long words", () => {
    for (const line of [
      "export { createMemorySuppressionStore } from './memory-suppression-store.js';",
      "// signed, stateless, constant-time confirmation links",
      "const color = '#ff00ff'; // short hex is fine",
      "const longButNoDigits = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz';",
      "// ======================================================================",
      "// the chaplin carries on; incremental and crypto words are fine",
    ]) {
      expect(scanLine(line), line).toEqual([]);
    }
  });

  it("HARD-FAILS on a scan root that does not exist, rather than passing vacuously", () => {
    expect(() => scanForLeaks([join(repoRoot, "definitely-not-a-real-root")])).toThrow(
      /scan root does not exist/,
    );
  });

  it("excludes only the scanner itself", () => {
    const self = join(repoRoot, "scripts", j("no-", "leaks.mjs"));
    expect(scanFiles([self])).toEqual([]);
  });
});
