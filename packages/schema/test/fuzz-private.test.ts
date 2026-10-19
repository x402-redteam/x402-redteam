import { describe, expect, it } from "vitest";
import { FUZZ_PRIVATE_MARKER, stampJson, stampJsonl, stampText } from "../src/fuzz-private.js";

describe("fuzz private marker", () => {
  it("stamps JSON with the marker first", () => {
    const v = stampJson({ a: 1 });
    expect(Object.keys(v)).toEqual([FUZZ_PRIVATE_MARKER, "a"]);
    expect(v[FUZZ_PRIVATE_MARKER]).toBe(true);
  });

  it("stamps every JSONL row", () => {
    const lines = stampJsonl([{ a: 1 }, { b: 2 }])
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(JSON.parse(l)[FUZZ_PRIVATE_MARKER]).toBe(true);
    expect(stampJsonl([])).toBe("");
  });

  it("stamps YAML and Markdown on the first line", () => {
    expect(stampText("yaml", "id: x\n").split("\n")[0]).toBe(`# ${FUZZ_PRIVATE_MARKER}`);
    expect(stampText("md", "# t").split("\n")[0]).toBe(`<!-- ${FUZZ_PRIVATE_MARKER} -->`);
  });
});
