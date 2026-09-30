import { describe, expect, it, vi } from "vitest";
import { validate } from "../src/validate.js";

const GOOD_CORPUS = new URL("./fixtures/corpus", import.meta.url).pathname;
const BROKEN_CORPUS = new URL("./fixtures/broken-corpus", import.meta.url).pathname;

describe("validate", () => {
  it("exits 0 on a valid corpus", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(validate(GOOD_CORPUS)).toBe(0);
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
});
