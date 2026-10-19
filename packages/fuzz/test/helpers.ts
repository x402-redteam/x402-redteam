import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_CATALOGUE = fileURLToPath(new URL("../catalogue-public", import.meta.url));

export function tmp(prefix = "x402-fuzz-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes `{relative path: text}` as a catalogue directory. */
export function writeCatalogue(files: Record<string, string>): string {
  const dir = tmp("x402-fuzz-cat-");
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

/** Every file under `dir` as {relative path: text}, for byte-for-byte comparison. */
export function readTree(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(out, readTree(dir, rel));
    else out[rel] = readFileSync(join(dir, rel), "utf8");
  }
  return out;
}

export const CITE = `cite:
  file: specs/example.md
  commit: 0e6e8c55d86b4f14234fb6e49a4052074fb93e57
  quote: "A quoted sentence that MUST hold."
`;

export const BASE = (family: string) => `id: ${family}-base\nfamily: ${family}\nbase: true\n`;
