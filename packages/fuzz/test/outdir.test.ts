import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertOutDirAllowed, generate } from "../src/index.js";
import { PUBLIC_CATALOGUE, tmp } from "./helpers.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

describe("--out safety", () => {
  it("refuses paths inside the repository", () => {
    expect(() => assertOutDirAllowed(join(REPO, "out-fuzz"))).toThrow(/inside a git repository/);
    expect(() => assertOutDirAllowed(join(REPO, "packages", "fuzz", "gen"))).toThrow(
      /inside a git repository/,
    );
    expect(() => assertOutDirAllowed(REPO)).toThrow(/inside a git repository/);
  });

  it("allows *.fuzz and fuzz-out inside the repository, and anything outside it", () => {
    expect(() => assertOutDirAllowed(join(REPO, "x.fuzz"))).not.toThrow();
    expect(() => assertOutDirAllowed(join(REPO, "fuzz-out", "run1"))).not.toThrow();
    expect(() => assertOutDirAllowed(join(tmp(), "any", "where"))).not.toThrow();
  });

  it("generate() refuses an in-repo --out before writing anything", () => {
    const bad = join(REPO, "not-private-out");
    expect(() => generate({ catalogueDir: PUBLIC_CATALOGUE, shape: "page", outDir: bad })).toThrow(
      /inside a git repository/,
    );
  });
});
