import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, compareCodeUnits } from "../src/canonical.js";

const here = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("compareCodeUnits", () => {
  it("orders by UTF-16 code unit", () => {
    const input = ["a_b", "a-b", "A", "a", "é"];
    expect([...input].sort(compareCodeUnits)).toEqual(["A", "a", "a-b", "a_b", "é"]);
  });

  it("returns 0 for equal strings", () => {
    expect(compareCodeUnits("x", "x")).toBe(0);
  });
});

describe("canonicalize", () => {
  it("sorts keys of nested objects and keeps array order", () => {
    const out = canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }, 1], c: null }, B: 0 });
    expect(JSON.stringify(out)).toBe('{"B":0,"a":{"c":null,"d":[3,{"y":2,"z":1},1]},"b":1}');
  });

  it("produces the same key order under different locales", () => {
    const script = [
      "const keys = ['a_b','a-b','A','a','I','i','\\u0131','\\u00e9','z'];",
      "const o = Object.fromEntries(keys.map((k) => [k, 1]));",
      "const sorted = Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));",
      "process.stdout.write(JSON.stringify(sorted));",
    ].join("");
    const outputs = ["tr_TR.UTF-8", "sv_SE.UTF-8", "C"].map((lang) =>
      execFileSync(process.execPath, ["-e", script], {
        env: { ...process.env, LANG: lang, LC_ALL: lang },
        encoding: "utf8",
      }),
    );
    expect(new Set(outputs).size).toBe(1);
    const expected = ["A", "I", "a", "a-b", "a_b", "i", "z", "é", "ı"];
    expect(JSON.parse(outputs[0] as string)).toEqual(expected);
    const shuffled = Object.fromEntries([...expected].reverse().map((k) => [k, 1]));
    expect(Object.keys(canonicalize(shuffled) as object)).toEqual(expected);
  });
});

describe("source tree", () => {
  it("contains no locale-dependent string comparison", () => {
    const root = join(here, "..", "..");
    const offenders: string[] = [];
    for (const pkg of readdirSync(root)) {
      const src = join(root, pkg, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of sourceFiles(src)) {
        if (readFileSync(file, "utf8").includes("localeCompare")) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
