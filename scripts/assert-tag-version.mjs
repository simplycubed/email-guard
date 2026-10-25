#!/usr/bin/env node
/**
 * ASSERT-TAG-VERSION — the publish gate's tag-truthfulness check.
 *
 * A published version is IMMUTABLE. `v0.2.0` cut from a tree whose package.json still
 * says `0.1.0` publishes `0.1.0` under a tag that claims otherwise — and the mismatch is
 * then discovered by a consumer, months later, as "the version I pinned isn't the code I
 * read". Unpublishing is disruptive at best and blocked at worst, so this is checked
 * BEFORE the irreversible step, not after.
 *
 * The check takes the RAW ref (`refs/tags/v0.1.0`), not a pre-stripped tag name, because
 * ref parsing is where this actually goes wrong: `github.ref` and `github.ref_name` differ
 * by that prefix and are trivially swapped in YAML. Requiring the full ref means a
 * workflow wired to a branch push — or to a non-tag ref of any kind — fails loudly here
 * instead of publishing off whatever happened to be checked out.
 *
 * Deliberately strict, in all three directions:
 *   - the ref MUST be `refs/tags/…`             (not a branch, not a bare tag name)
 *   - the tag MUST carry the leading `v`        (`0.1.0` is not this repo's tag shape)
 *   - the remainder MUST equal the version EXACTLY (no coercion, no semver-range logic —
 *     `v0.1.0` and `v0.01.0` are different tags and only one of them is the version)
 *
 * Usage: node scripts/assert-tag-version.mjs [ref]     (defaults to $GITHUB_REF)
 * Exits 0 on a match, 1 on anything else. `assertTagVersion` is imported by the vitest
 * gate, which proves each failure mode fires.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

const TAG_REF_PREFIX = "refs/tags/";

/** Read the `version` field of the package.json next to this repo's root. */
export function readPackageVersion(repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("assert-tag-version: package.json has no usable `version` field");
  }
  return pkg.version;
}

/**
 * Throw unless `ref` is a tag ref naming exactly `v${version}`.
 *
 * Returns the tag on success so a caller can log the thing it verified rather than the
 * thing it was handed.
 */
export function assertTagVersion(ref, version) {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error(
      "assert-tag-version: no ref supplied — pass one, or set GITHUB_REF " +
        `(expected "${TAG_REF_PREFIX}v${version}")`,
    );
  }
  if (!ref.startsWith(TAG_REF_PREFIX)) {
    throw new Error(
      `assert-tag-version: ref is not a tag ref: "${ref}". Publishing is tag-triggered ` +
        `— pass \${{ github.ref }}, which carries the "${TAG_REF_PREFIX}" ` +
        "prefix, not \\${{ github.ref_name }}.",
    );
  }

  const tag = ref.slice(TAG_REF_PREFIX.length);
  if (!tag.startsWith("v")) {
    throw new Error(
      `assert-tag-version: tag "${tag}" is missing the leading "v" — this repo publishes on ` +
        `"v*" tags, so the tag for version ${version} is "v${version}".`,
    );
  }

  const tagged = tag.slice(1);
  if (tagged !== version) {
    throw new Error(
      `assert-tag-version: TAG LIES. Tag "${tag}" would publish version "${version}" ` +
        `(package.json). Bump package.json to ${tagged} — or delete and re-cut the tag as ` +
        `"v${version}". A published version is immutable; this mismatch is not fixable after ` +
        "the fact.",
    );
  }
  return tag;
}

// CLI entrypoint.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const ref = process.argv[2] ?? process.env.GITHUB_REF ?? "";
  try {
    const version = readPackageVersion();
    const tag = assertTagVersion(ref, version);
    console.log(`assert-tag-version OK — ${tag} matches package.json version ${version}`);
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
