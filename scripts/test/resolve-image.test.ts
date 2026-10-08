import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, resolveImage } from "../ranked/resolve-image.mjs";

const SCRIPT = fileURLToPath(new URL("../ranked/resolve-image.mjs", import.meta.url));
const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "c".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const ENTRY = { commit: COMMIT, version: "v0.1.0", image: DIGEST };

describe("resolveImage", () => {
  it("finds an object entry by its vX.Y.Z version", () => {
    expect(resolveImage({ allow: ["d".repeat(40), ENTRY] }, "v0.1.0")).toEqual({
      ok: true,
      digest: DIGEST,
      commit: COMMIT,
      version: "v0.1.0",
    });
  });

  it("finds an object entry by its commit", () => {
    expect(resolveImage({ allow: [ENTRY] }, COMMIT)).toMatchObject({ ok: true, digest: DIGEST });
  });

  it("rejects a ref that no entry names", () => {
    const result = resolveImage({ allow: [ENTRY] }, "v0.2.0");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no _harness.json entry has version v0.2.0/);
  });

  it("rejects a ref listed only as a plain string entry", () => {
    const result = resolveImage({ allow: [COMMIT] }, COMMIT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/plain string/);
  });

  it("rejects a malformed image digest", () => {
    for (const image of ["sha256:abc", `sha512:${"b".repeat(64)}`, "b".repeat(64), 7]) {
      const result = resolveImage({ allow: [{ ...ENTRY, image }] }, "v0.1.0");
      expect(result.ok, String(image)).toBe(false);
      expect(result.error).toMatch(/malformed image digest/);
    }
  });

  it("rejects a malformed commit in the matched entry", () => {
    const result = resolveImage({ allow: [{ ...ENTRY, commit: "abc" }] }, "v0.1.0");
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/malformed commit/);
  });

  it("rejects two entries for the same ref", () => {
    const result = resolveImage({ allow: [ENTRY, { ...ENTRY, commit: OTHER_COMMIT }] }, "v0.1.0");
    expect(result.error).toMatch(/2 _harness.json entries/);
  });

  it("rejects a ref that is neither a tag nor a full commit, and a file without allow", () => {
    for (const ref of ["main", "v1.2", COMMIT.slice(0, 12), "--help", undefined]) {
      expect(resolveImage({ allow: [ENTRY] }, ref).ok, String(ref)).toBe(false);
    }
    expect(resolveImage({}, "v0.1.0").error).toMatch(/must be shaped like/);
    expect(resolveImage(null, "v0.1.0").ok).toBe(false);
  });
});

describe("resolve-image CLI", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resolve-image-"));
    file = join(dir, "_harness.json");
    writeFileSync(file, JSON.stringify({ allow: [ENTRY] }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints the digest when the entry's commit matches the checked-out commit", () => {
    const out = spawnSync(process.execPath, [SCRIPT], {
      env: { HARNESS_JSON: file, HARNESS_REF: "v0.1.0", HARNESS_COMMIT: COMMIT },
      encoding: "utf8",
    });
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(`${DIGEST}\n`);
  });

  it("fails when the entry names a different commit than the checked-out one", () => {
    const result = main({
      HARNESS_JSON: file,
      HARNESS_REF: "v0.1.0",
      HARNESS_COMMIT: OTHER_COMMIT,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^::error::.*checked-out harness/);
  });

  it("fails on a missing file, a missing commit and an unresolvable ref", () => {
    expect(
      main({
        HARNESS_JSON: join(dir, "absent.json"),
        HARNESS_REF: "v0.1.0",
        HARNESS_COMMIT: COMMIT,
      }).status,
    ).toBe(2);
    expect(main({ HARNESS_JSON: file, HARNESS_REF: "v0.1.0" }).status).toBe(2);
    expect(main({ HARNESS_JSON: file, HARNESS_REF: "v9.9.9", HARNESS_COMMIT: COMMIT }).status).toBe(
      2,
    );
    expect(main({ HARNESS_REF: "v0.1.0", HARNESS_COMMIT: COMMIT }).status).toBe(2);
  });
});
