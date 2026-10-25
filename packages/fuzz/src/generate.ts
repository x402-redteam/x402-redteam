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
import {
  type OfferedMcpTerms,
  offeredMcpTermsForScenario,
  offeredTermsForScenario,
} from "@x402-redteam/adversary";
import {
  canonicalize,
  FUZZ_PRIVATE_MARKER,
  lintGeneratedScenario,
  loadCorpus,
  MCP_CORPUS_DIRNAME,
  type McpChannel,
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
  LEGACY_SHAPES,
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
  /** sha256 of the canonical JSON of the offered `accepts` value as served, whatever its
   * JSON type (an array, object or string stays itself; `null` when the header
   * carries none). Identical in both shapes. */
  offered_terms_sha256: string;
  /** The `wire.encoding` kind that served the header (`standard` without `wire`). */
  wire_encoding: string;
  /** The raw `maxTimeoutSeconds` of the first offered entry, whatever its JSON type. */
  offered_max_timeout_seconds: unknown;
  /** What `expected.max_authorization_seconds` was set to (F8). */
  expected_max_authorization_seconds: number;
  /** U30-4 (D4, D10): the shapes that carry this case. Optional with no default in the
   * type: an older manifest has none, which `manifestShapes` reads as page and chat. */
  shapes?: Shape[];
  /** U30-4 (D7): the tier on each carried shape (`base` for a control). `tier` above is the
   * page/chat tier, the one `diff` echoes; an mcp client's oracle 2 reads this instead. */
  tier_by_shape?: Partial<Record<Shape, string>>;
  /** U30-4 (D3): present only for a case whose `wire.channels` is not `both`: the hash of each
   * channel's served `accepts` (as served, canonical JSON). `offered_terms_sha256` above is
   * then the hash of the patched object's `accepts`, which a differs mode does not serve
   * on every channel. */
  offered_terms_sha256_by_channel?: Partial<Record<McpChannel, string>>;
  /** U30-4 (D6): per channel the case serves, whether the served object passes
   * `@x402/core` 2.28.0's `parsePaymentRequired`. Present on cases that carry mcp. */
  sdk_schema_ok?: Partial<Record<McpChannel, boolean>>;
  /** U30-4 (D8, N4): the paid call's timer in ms when `@x402/mcp` reads a challenge that
   * passes the schema. Below `MCP_TIMING_SENSITIVE_MS` the case is timing-sensitive: run in
   * a separate private run with `--repeat 2`, out of the differential. Absent when none is read. */
  mcp_paid_timeout_ms?: number;
  /** U30-4: the JSON-RPC error code of a `jsonrpc*` case. The triage notes the `-32042`
   * collision only for that code. */
  mcp_error_code?: number;
}

/** U30-4 (D8): a paid-call timer under this many ms makes an mcp case timing-sensitive. */
export const MCP_TIMING_SENSITIVE_MS = 5000;

/** The shapes a manifest case is carried by (absent `shapes` means page and chat). */
export function manifestShapes(mc: Pick<ManifestCase, "shapes">): readonly Shape[] {
  return mc.shapes ?? LEGACY_SHAPES;
}

/**
 * `cases.json`. Contract for U29-3 (`diff`): re-hash `wire.offered.accepts` (unfiltered, the
 * value as issued, whatever its JSON type) from the run record, or the ledger's `accepts` when there is no
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
  /** Per shape; a manifest written before U30-4 has no `mcp` key. */
  corpus_hash: Partial<Record<Shape, string>>;
  counts: {
    cases: number;
    bases: number;
    by_tier: Record<string, number>;
    /** U30-4 (D4): per shape, the cases it does not carry. Optional for older manifests. */
    skipped?: Record<Shape, number>;
  };
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
  rawAccepts: unknown;
  encoding: string;
  maxAuthSeconds: number;
  /** mcp only: what the tool route serves, per channel. */
  mcp?: OfferedMcpTerms;
}

/** Builds the cases that carry `shape` (D4), in case order. */
function buildShape(cases: FuzzCase[], shape: Shape, renderSeed: string): Built[] {
  return cases
    .filter((c) => c.shapes.includes(shape))
    .map((c) => {
      const input = buildScenarioInput(c, shape);
      let scenario = parseScenarioInput(input);
      const mcp =
        shape === "mcp"
          ? (offeredMcpTermsForScenario(scenario, "evm", renderSeed) ?? undefined)
          : undefined;
      const offered =
        mcp !== undefined
          ? { accepts: mcp.accepts, rawAccepts: mcp.rawAccepts, encoding: mcp.encoding as string }
          : offeredTermsForScenario(scenario, "evm", renderSeed);
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
        rawAccepts: offered.rawAccepts,
        encoding: offered.encoding,
        maxAuthSeconds,
        ...(mcp !== undefined ? { mcp } : {}),
      };
    });
}

/** The directory a shape is written to: mcp scenarios live in `corpus-mcp/` (ADR-035). */
function corpusDirName(shape: Shape): string {
  return shape === "mcp" ? MCP_CORPUS_DIRNAME : "corpus";
}

function writeShape(built: Built[], dir: string): void {
  for (const b of built) {
    const file = join(dir, b.c.family, `${b.scenario.id}.yaml`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, stampText("yaml", stringifyYaml(b.input, { lineWidth: 0 })));
  }
}

/** Writes `built` to a scratch directory, loads it with the real loader (so every lint rule
 * runs) and hashes what it loaded. The mcp shape is loaded from a directory named
 * `corpus-mcp` (the loader's partition rule); `corpusHash` does not depend on the path, so
 * the result equals the hash of the written output directory (D14). */
function hashShape(built: Built[], shape: Shape): string {
  const tmp = mkdtempSync(join(tmpdir(), "x402-fuzz-"));
  try {
    const dir = shape === "mcp" ? join(tmp, MCP_CORPUS_DIRNAME) : tmp;
    writeShape(built, dir);
    return corpusHash(loadCorpus(dir));
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

  // Built cases are keyed by id, never by array position (D4): a shape carries a subset.
  const byShape = Object.fromEntries(
    SHAPES.map((shape) => [shape, buildShape(cases, shape, renderSeed)]),
  ) as Record<Shape, Built[]>;
  const built = (shape: Shape, id: string): Built | undefined =>
    byShape[shape].find((b) => b.c.id === id);

  const hashes = {} as Record<Shape, string>;
  for (const shape of SHAPES) hashes[shape] = hashShape(byShape[shape], shape);

  const manifestCases: ManifestCase[] = cases.map((c) => {
    const page = built("page", c.id);
    const chat = built("chat", c.id);
    const mcp = built("mcp", c.id);
    const http = page ?? chat;
    if (page !== undefined && chat !== undefined) {
      if (sha256Canonical(page.rawAccepts) !== sha256Canonical(chat.rawAccepts)) {
        throw new Error(`${c.id}: offered terms differ between the page and chat shapes`);
      }
    }
    const channelMode = mcp?.mcp?.mode ?? "both";
    // A case with `both` channels (or none) serves the same terms on mcp as on page: the
    // cross-shape check now covers mcp vs page for every case both carry.
    if (http !== undefined && mcp !== undefined) {
      if (sha256Canonical(http.rawAccepts) !== sha256Canonical(mcp.rawAccepts)) {
        throw new Error(`${c.id}: offered terms differ between the page and mcp shapes`);
      }
    }
    const primary = (http ?? mcp) as Built;
    const offeredHash = sha256Canonical(primary.rawAccepts);
    const first = Array.isArray(primary.accepts) ? primary.accepts[0] : undefined;
    const channelHashes =
      mcp?.mcp !== undefined && channelMode !== "both"
        ? Object.fromEntries(
            Object.entries(mcp.mcp.channels).map(([ch, offer]) => [
              ch,
              sha256Canonical(offer.accepts),
            ]),
          )
        : undefined;
    return {
      id: c.id,
      scenario_id: primary.scenario.id,
      family: c.family,
      base_id: c.baseId,
      is_base: c.isBase,
      tier: c.tier,
      category: c.category,
      technique: `fuzz:${c.id}`,
      cite: c.cite,
      expected_kind: c.expectedKind,
      offered_terms_sha256: offeredHash,
      wire_encoding: primary.encoding,
      offered_max_timeout_seconds:
        first !== null && typeof first === "object"
          ? ((first as Record<string, unknown>).maxTimeoutSeconds ?? null)
          : null,
      expected_max_authorization_seconds: primary.maxAuthSeconds,
      shapes: c.shapes,
      tier_by_shape: c.tierByShape as Partial<Record<Shape, string>>,
      // Every mode other than `both` records it, an empty object included (a `text_raw`
      // literal that is not an object serves no readable channel): alignment then expects
      // an empty recorded set.
      ...(channelHashes !== undefined ? { offered_terms_sha256_by_channel: channelHashes } : {}),
      ...(mcp?.mcp?.error_code !== undefined ? { mcp_error_code: mcp.mcp.error_code } : {}),
      ...(mcp?.mcp !== undefined ? { sdk_schema_ok: mcp.mcp.sdk_schema_ok } : {}),
      ...(mcp?.mcp?.paid_timeout_ms != null
        ? { mcp_paid_timeout_ms: mcp.mcp.paid_timeout_ms }
        : {}),
    };
  });

  const byTier: Record<string, number> = {};
  for (const m of manifestCases) byTier[m.tier] = (byTier[m.tier] ?? 0) + 1;
  const skipped = Object.fromEntries(
    SHAPES.map((shape) => [shape, cases.length - byShape[shape].length]),
  ) as Record<Shape, number>;
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
      skipped,
    },
    cases: manifestCases,
  };

  // `--shape mcp` clears a stale `corpus/` and the reverse (D4).
  const corpusDir = join(opts.outDir, corpusDirName(opts.shape));
  const casesPath = join(opts.outDir, "cases.json");
  for (const shape of SHAPES)
    rmSync(join(opts.outDir, corpusDirName(shape)), { recursive: true, force: true });
  rmSync(casesPath, { force: true });
  mkdirSync(corpusDir, { recursive: true });
  writeShape(byShape[opts.shape], corpusDir);
  writeFileSync(casesPath, `${JSON.stringify(stampJson({ ...manifest }), null, 2)}\n`);
  return { manifest, corpusDir, casesPath };
}
