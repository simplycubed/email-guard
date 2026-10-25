/**
 * THE PUBLISH GATE, WATCHED FIRING (AGENTS.md "Gate").
 *
 * The tag-truthfulness check guards an IRREVERSIBLE step, and the only way to exercise
 * it end to end in CI would be to cut a real tag and publish a real immutable version —
 * which is exactly what it exists to prevent. So it is verified here instead, as a pure
 * function over the raw ref, with a negative control on every failure mode it claims to
 * catch. A gate nobody has watched fire is a false clear.
 *
 * The interesting cases are all ref-shaped, not version-shaped: `github.ref` vs
 * `github.ref_name` differ only by the `refs/tags/` prefix and are trivially swapped in
 * YAML, so "was handed a bare tag name" and "was handed a branch ref" are the realistic
 * bugs — not a typo'd semver.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — JS module, no types; exports assertTagVersion/readPackageVersion.
import { assertTagVersion, readPackageVersion } from "../scripts/assert-tag-version.mjs";

describe("assert-tag-version — the matching case", () => {
  it("accepts a tag ref naming exactly the package version", () => {
    expect(assertTagVersion("refs/tags/v1.2.3", "1.2.3")).toBe("v1.2.3");
  });

  it("accepts a prerelease tag when package.json carries the same prerelease", () => {
    // Nothing here parses semver; the prerelease suffix is just more characters that
    // have to match. Asserting it keeps a future 'strip the prerelease' 'fix' honest.
    expect(assertTagVersion("refs/tags/v0.2.0-rc.1", "0.2.0-rc.1")).toBe("v0.2.0-rc.1");
  });

  it("agrees with the real package.json — the tag to cut today is v<version>", () => {
    const version = readPackageVersion();
    expect(assertTagVersion(`refs/tags/v${version}`, version)).toBe(`v${version}`);
  });
});

describe("assert-tag-version — NEGATIVE CONTROL (the check can go red)", () => {
  it("rejects a tag whose version disagrees with package.json (the tag that lies)", () => {
    expect(() => assertTagVersion("refs/tags/v0.2.0", "0.1.0")).toThrow(/TAG LIES/);
  });

  it("rejects a bare tag name — the github.ref_name / github.ref swap", () => {
    expect(() => assertTagVersion("v0.1.0", "0.1.0")).toThrow(/not a tag ref/);
  });

  it("rejects a branch ref, so a mis-wired trigger cannot publish", () => {
    expect(() => assertTagVersion("refs/heads/main", "0.1.0")).toThrow(/not a tag ref/);
  });

  it("rejects a tag missing the leading v", () => {
    expect(() => assertTagVersion("refs/tags/0.1.0", "0.1.0")).toThrow(/missing the leading/);
  });

  it("rejects an empty ref rather than treating absence as agreement", () => {
    // An unset GITHUB_REF must not read as "nothing to disagree with".
    expect(() => assertTagVersion("", "0.1.0")).toThrow(/no ref supplied/);
    expect(() => assertTagVersion(undefined, "0.1.0")).toThrow(/no ref supplied/);
  });

  it("does not coerce a numerically-equal but textually-different version", () => {
    // `v0.01.0` and `v0.1.0` are different tags; only one is the published version.
    expect(() => assertTagVersion("refs/tags/v0.01.0", "0.1.0")).toThrow(/TAG LIES/);
  });
});
