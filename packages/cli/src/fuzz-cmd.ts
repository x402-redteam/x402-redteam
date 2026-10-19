import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertOutDirAllowed,
  type ClientInput,
  DiffRefusal,
  diffRuns,
  generate,
  loadRunDir,
  parseClientSpec,
  parseManifest,
  SHAPES,
  type Shape,
  writeDiff,
} from "@x402-redteam/fuzz";

/** `x402-redteam fuzz`: returns the counts-only stdout line; throws on any refusal. */
export function runFuzzCommand(opts: {
  catalogue: string;
  shape: string;
  out: string;
  pairwiseSeed?: string;
  renderSeed?: string;
}): string {
  if (!(SHAPES as readonly string[]).includes(opts.shape)) {
    throw new Error(`--shape "${opts.shape}" is invalid (expected page|chat)`);
  }
  const { manifest, corpusDir } = generate({
    catalogueDir: resolve(opts.catalogue),
    shape: opts.shape as Shape,
    outDir: resolve(opts.out),
    pairwiseSeed: opts.pairwiseSeed,
    renderSeed: opts.renderSeed,
  });
  // Counts only: fuzz content stays private (ADR-028 #7).
  return `fuzz: ${manifest.counts.cases} case(s) (${manifest.counts.bases} base), shape ${opts.shape}, corpus ${corpusDir}`;
}

/** `x402-redteam diff`: returns the counts-only stdout line; throws on any refusal. */
export function runDiffCommand(
  opts: { manifest: string; out: string; client?: string[] },
  runDirs: string[],
): string {
  const specs = (opts.client ?? []).map(parseClientSpec);
  const withDir = specs.filter((s) => s.dir !== undefined).length;
  if (withDir !== 0 && withDir !== specs.length) {
    throw new DiffRefusal("give dir= on every --client, or none and pass run dirs positionally");
  }
  const dirs = withDir > 0 ? specs.map((s) => s.dir as string) : runDirs;
  if (specs.length === 0 || dirs.length !== specs.length) {
    throw new DiffRefusal(
      `need one --client per run directory (got ${specs.length} --client, ${dirs.length} run dir)`,
    );
  }
  assertOutDirAllowed(resolve(opts.out));
  const manifest = parseManifest(JSON.parse(readFileSync(resolve(opts.manifest), "utf8")));
  const inputs: ClientInput[] = specs.map((client, i) => ({
    client,
    data: loadRunDir(resolve(dirs[i] as string)),
  }));
  const result = diffRuns(manifest, inputs);
  writeDiff(resolve(opts.out), result, manifest);
  const c = result.counts;
  return (
    `diff: ${c.cases} case(s), ${c.flagged} flagged, invariant ${c.invariant}, expectation ${c.expectation}, ` +
    `differential wrapper ${c.differential_wrapper} / implementation ${c.differential_implementation}, voided ${c.voided}, ` +
    `missing ${result.clients.map((k) => `${k.id}=${k.missing_cases}`).join(" ")}`
  );
}

/** A repeatable commander option: each use appends to the list. */
export function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
