import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { offeredTermsForScenario } from "@x402-redteam/adversary";
import {
  canonicalize,
  FUZZ_PRIVATE_MARKER,
  lintGeneratedScenario,
  loadCorpus,
  type Scenario,
  stampJson,
  stampText,
} from "@x402-redteam/schema";
import { corpusHash } from "@x402-redteam/scorer";
import { stringify as stringifyYaml } from "yaml";
import {
  buildScenarioInput,
  DEFAULT_RENDER_SEED,
  type FuzzCase,
  parseScenarioInput,
  resolveCases,
  SHAPES,
  type Shape,
  TASK_HOSTS,
} from "./cases.js";
import { type Catalogue, loadCatalogue } from "./catalogue.js";
import { assertOutDirAllowed } from "./outdir.js";

export const MANIFEST_VERSION = 1;

export interface GenerateOptions {
  catalogueDir: string;
  shape: Shape;
  outDir: string;
  pairwiseSeed?: string;
  /** The seed canary addresses derive from; must equal the `--seed` of the runs. */
  renderSeed?: string;
}

export interface ManifestCase {
  /** The mutation id; the scenario id (identical in both shapes) is `scenario_id`. */
  id: string;
  scenario_id: string;
  family: string;
  base_id: string;
  is_base: boolean;
  tier: string;
  category: string;
  technique: string;
  cite: { file: string; commit: string; quote: string } | null;
  expected_kind: string | null;
  /** sha256 of the canonical JSON of the offered `accepts` array (`null` when the header
   * carries none). Identical in both shapes. */
  offered_terms_sha256: string;
  /** The `wire.encoding` kind that served the header (`standard` without `wire`). */
  wire_encoding: string;
  /** The raw `maxTimeoutSeconds` of the first offered entry, whatever its JSON type. */
  offered_max_timeout_seconds: unknown;
  /** What `expected.max_authorization_seconds` was set to (F8). */
  expected_max_authorization_seconds: number;
}

/**
 * `cases.json`. Contract for U29-3 (`diff`): re-hash `wire.offered.accepts` (unfiltered, the
 * whole array as issued) from the run record, or the ledger's `accepts` when there is no
 * `wire`, and compare with `offered_terms_sha256`; and require the run's `seed` to equal
 * `render_seed` (canary addresses derive from it), refusing otherwise.
 */
export interface Manifest {
  manifest_version: number;
  shape_written: Shape;
  render_seed: string;
  chain: "evm";
  pairwise_seed: string | null;
  catalogue_sha256: string;
  corpus_hash: Record<Shape, string>;
  counts: { cases: number; bases: number; by_tier: Record<string, number> };
  cases: ManifestCase[];
}

export interface GenerateResult {
  manifest: Manifest;
  corpusDir: string;
  casesPath: string;
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

interface Built {
  c: FuzzCase;
  scenario: Scenario;
  input: Record<string, unknown>;
  accepts: unknown[] | null;
  encoding: string;
  maxAuthSeconds: number;
}

function buildShape(cases: FuzzCase[], shape: Shape, renderSeed: string): Built[] {
  return cases.map((c) => {
    const input = buildScenarioInput(c, shape);
    let scenario = parseScenarioInput(input);
    const offered = offeredTermsForScenario(scenario, "evm", renderSeed);
    if (offered === null) throw new Error(`${c.id}: no challenge route`);
    // F8: the wire value when it is a positive integer, else the family base's value.
    const first = Array.isArray(offered.accepts) ? offered.accepts[0] : undefined;
    const wireTimeout =
      first !== null && typeof first === "object"
        ? (first as Record<string, unknown>).maxTimeoutSeconds
        : undefined;
    const maxAuthSeconds =
      typeof wireTimeout === "number" && Number.isSafeInteger(wireTimeout) && wireTimeout > 0
        ? wireTimeout
        : c.baseTimeoutSeconds;
    (input.expected as Record<string, unknown>).max_authorization_seconds = maxAuthSeconds;
    scenario = parseScenarioInput(input);

    const violations = lintGeneratedScenario(scenario, TASK_HOSTS, {
      case_input: { challenge: c.challenge, wire: c.wire },
    });
    if (violations.length > 0) {
      const v = violations[0];
      throw new Error(`${c.id}: generator lint (${v?.rule}) ${v?.path}: ${v?.message}`);
    }
    return {
      c,
      scenario,
      input,
      accepts: offered.accepts,
      encoding: offered.encoding,
      maxAuthSeconds,
    };
  });
}

function writeShape(built: Built[], dir: string): void {
  for (const b of built) {
    const file = join(dir, b.c.family, `${b.scenario.id}.yaml`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, stampText("yaml", stringifyYaml(b.input, { lineWidth: 0 })));
  }
}

/** Writes `built` to a scratch directory, loads it with the real loader (so every lint rule
 * runs) and hashes what it loaded. */
function hashShape(built: Built[]): string {
  const tmp = mkdtempSync(join(tmpdir(), "x402-fuzz-"));
  try {
    writeShape(built, tmp);
    return corpusHash(loadCorpus(tmp));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** An existing `--out` is reused only when it is empty or holds a previous run of ours
 * (a `cases.json` carrying the private marker); anything else is refused, never deleted. */
function assertOutDirReusable(outDir: string): void {
  if (!existsSync(outDir)) return;
  if (readdirSync(outDir).length === 0) return;
  const cases = join(outDir, "cases.json");
  if (existsSync(cases) && readFileSync(cases, "utf8").includes(FUZZ_PRIVATE_MARKER)) return;
  throw new Error(
    `--out ${outDir} exists and is not empty or a previous fuzz output; refusing to overwrite it`,
  );
}

export function generate(opts: GenerateOptions): GenerateResult {
  assertOutDirAllowed(opts.outDir);
  const renderSeed = opts.renderSeed ?? DEFAULT_RENDER_SEED;
  assertOutDirReusable(opts.outDir);
  const catalogue: Catalogue = loadCatalogue(opts.catalogueDir);
  const cases = resolveCases(catalogue, opts.pairwiseSeed);

  const byShape = {
    page: buildShape(cases, "page", renderSeed),
    chat: buildShape(cases, "chat", renderSeed),
  } as Record<Shape, Built[]>;

  const hashes = {} as Record<Shape, string>;
  for (const shape of SHAPES) hashes[shape] = hashShape(byShape[shape]);

  const manifestCases: ManifestCase[] = cases.map((c, i) => {
    const page = byShape.page[i] as Built;
    const chat = byShape.chat[i] as Built;
    const pageHash = sha256Canonical(page.accepts);
    if (pageHash !== sha256Canonical(chat.accepts)) {
      throw new Error(`${c.id}: offered terms differ between the page and chat shapes`);
    }
    const first = Array.isArray(page.accepts) ? page.accepts[0] : undefined;
    return {
      id: c.id,
      scenario_id: page.scenario.id,
      family: c.family,
      base_id: c.baseId,
      is_base: c.isBase,
      tier: c.tier,
      category: c.category,
      technique: `fuzz:${c.id}`,
      cite: c.cite,
      expected_kind: c.expectedKind,
      offered_terms_sha256: pageHash,
      wire_encoding: page.encoding,
      offered_max_timeout_seconds:
        first !== null && typeof first === "object"
          ? ((first as Record<string, unknown>).maxTimeoutSeconds ?? null)
          : null,
      expected_max_authorization_seconds: page.maxAuthSeconds,
    };
  });

  const byTier: Record<string, number> = {};
  for (const m of manifestCases) byTier[m.tier] = (byTier[m.tier] ?? 0) + 1;
  const manifest: Manifest = {
    manifest_version: MANIFEST_VERSION,
    shape_written: opts.shape,
    render_seed: renderSeed,
    chain: "evm",
    pairwise_seed: opts.pairwiseSeed ?? null,
    catalogue_sha256: sha256Canonical(catalogue.sources),
    corpus_hash: hashes,
    counts: {
      cases: manifestCases.length,
      bases: manifestCases.filter((m) => m.is_base).length,
      by_tier: Object.fromEntries(Object.entries(byTier).sort(([a], [b]) => (a < b ? -1 : 1))),
    },
    cases: manifestCases,
  };

  const corpusDir = join(opts.outDir, "corpus");
  const casesPath = join(opts.outDir, "cases.json");
  rmSync(corpusDir, { recursive: true, force: true });
  rmSync(casesPath, { force: true });
  mkdirSync(corpusDir, { recursive: true });
  writeShape(byShape[opts.shape], corpusDir);
  writeFileSync(casesPath, `${JSON.stringify(stampJson({ ...manifest }), null, 2)}\n`);
  return { manifest, corpusDir, casesPath };
}
