import { readFileSync } from "node:fs";

/**
 * The repository version (ADR-021 §1), read from the root package.json. The path is the
 * same from `src/` and from a built `dist/`: both sit three levels below the root.
 */
export const HARNESS_VERSION: string = (
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
