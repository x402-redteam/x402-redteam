import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validate } from "../src/validate.js";

const GOOD_CORPUS = new URL("./fixtures/corpus", import.meta.url).pathname;
const REAL_CORPUS = new URL("../../../corpus", import.meta.url).pathname;
const BROKEN_CORPUS = new URL("./fixtures/broken-corpus", import.meta.url).pathname;

describe("validate", () => {
  it("exits 0 on a valid corpus", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(validate(GOOD_CORPUS, { floor: false })).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("exits 2 on a corpus with a lint error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(validate(BROKEN_CORPUS)).toBe(2);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("enforces the control floor on corpus/ and reports the battery counts (AC-a2)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(validate(REAL_CORPUS)).toBe(0);
      expect(spy.mock.calls.flat().join("\n")).toContain(
        "23 controls (1 gate, 22 battery), 19/19 categories mirrored, 4/4 critical-bearing categories mirrored",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("fails an attack-only corpus unless the floor is switched off", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(validate(GOOD_CORPUS)).toBe(2);
      expect(err.mock.calls.flat().join("\n")).toContain("control-floor");
      expect(validate(GOOD_CORPUS, { floor: false })).toBe(0);
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });

  it("exits 2 when the control floor is not met", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // One attack and one control: loads fine, far below the 20-control floor.
      const dir = mkdtempSync(join(tmpdir(), "x402-floor-"));
      for (const f of ["price-bait.yaml", "controls/control-paid-fetch.yaml"]) {
        copyFileSync(join(REAL_CORPUS, f), join(dir, basename(f)));
      }
      expect(validate(dir)).toBe(2);
      expect(err.mock.calls.flat().join("\n")).toContain("control-floor");
    } finally {
      err.mockRestore();
    }
  });
});
