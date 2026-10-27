import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  CategorySchema,
  compareCodeUnits,
  isBothChannels,
  parseWireChannels,
} from "@x402-redteam/schema";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * The fuzz catalogue (U29-2, design §2 and §3, ADR-033): a directory of YAML or JSON files,
 * one mutation per file. Pure data: nothing here touches the network or the clock.
 */

export const TIERS = ["spec-must", "spec-type", "undefined"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * The x402 HTTP transport spec file(s) a citation can name (U30-4, D7, N3). A tier written
 * against one of these binds the HTTP header encoding and the 402 body, not MCP, so on the
 * `mcp` shape the entry's tier is `undefined`. The one place the rule's paths live.
 */
export const HTTP_TRANSPORT_SPEC_FILES: readonly string[] = ["specs/transports-v2/http.md"];

/** True when `file` names the HTTP transport spec (an exact path, or under any prefix). */
export function isHttpTransportSpec(file: string): boolean {
  return HTTP_TRANSPORT_SPEC_FILES.some((p) => file === p || file.endsWith(`/${p}`));
}

export const EXPECTED_KINDS = ["refuse", "pay_exactly"] as const;
export type ExpectedKind = (typeof EXPECTED_KINDS)[number];

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const kebab = z.string().regex(KEBAB, "must be kebab-case (a-z, 0-9 and single dashes)");

/** A spec citation: the quoted sentence, the spec file and the pinned upstream commit. */
export const CiteSchema = z
  .object({
    file: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-hex commit SHA"),
    quote: z.string().min(1),
  })
  .strict();
export type Cite = z.infer<typeof CiteSchema>;

const WireOverrideSchema = z
  .object({
    patch: z.record(z.string(), z.unknown()).optional(),
    encoding: z.string().min(1).optional(),
    body: z.enum(["same", "differs", "none"]).optional(),
    /** MCP only (U30-4): where the tool route puts the challenge. See `WireSpec.channels`. */
    channels: z
      .string()
      .refine((v) => parseWireChannels(v) !== null, { message: "not a wire.channels value" })
      .optional(),
  })
  .strict();

const ChallengeOverrideSchema = z.record(z.string(), z.unknown());

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export const CatalogueEntrySchema = z
  .object({
    id: kebab,
    family: kebab,
    /** The family's unmutated fair challenge: a control. Exactly one per family. */
    base: z.boolean().optional(),
    tier: z.enum(TIERS).optional(),
    /** An existing scenario category (N1): no new enum. A base entry's is `control`. */
    category: CategorySchema.optional(),
    cite: CiteSchema.optional(),
    expected_kind: z.enum(EXPECTED_KINDS).optional(),
    /** A typed ChallengeSpec override merged over the family's base challenge; `null`
     * deletes a key. */
    challenge: ChallengeOverrideSchema.optional(),
    /** Sugar: field overrides for the first `accepts` entry, expanded into a whole-array
     * wire patch (RFC 7396 replaces arrays whole). The string `"$null"` writes a JSON null. */
    accept_patch: z.record(z.string(), z.unknown()).optional(),
    wire: WireOverrideSchema.optional(),
    note: z.string().optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (e.base === true) {
      if (e.tier !== undefined) issue("tier", "a base entry has no tier");
      if (e.cite !== undefined) issue("cite", "a base entry has no cite");
      if (e.expected_kind !== undefined)
        issue("expected_kind", "a base entry has no expected_kind");
      if (e.wire !== undefined || e.accept_patch !== undefined) {
        issue("wire", "a base entry is the unmutated challenge: no wire or accept_patch");
      }
      if (e.category !== undefined && e.category !== "control") {
        issue("category", 'a base entry\'s category is "control"');
      }
      return;
    }
    if (e.tier === undefined) issue("tier", "tier is required");
    if (e.category === undefined) issue("category", "category is required");
    if (e.category === "control") issue("category", 'a mutation is never category "control"');
    if (e.tier === "spec-must") {
      if (e.cite === undefined) issue("cite", "cite is required for spec-must");
      else if (!/\bMUST\b|\bmust\b/.test(e.cite.quote)) {
        issue("cite", "a spec-must quote must contain MUST or must (a stated requirement)");
      }
      if (e.expected_kind === undefined)
        issue("expected_kind", "expected_kind is required for spec-must");
    } else if (e.expected_kind !== undefined) {
      issue("expected_kind", "expected_kind is for spec-must only");
    }
    if (e.wire?.channels !== undefined) {
      const raw = parseWireChannels(e.wire.channels);
      if (raw?.mode === "structured_raw" && !isJson(raw.arg ?? "")) {
        issue("wire", `entry ${e.id}: wire.channels structured_raw literal is not JSON`);
      }
      if (e.wire.encoding !== undefined || e.wire.body !== undefined) {
        issue("wire", "wire.channels is MCP only; wire.encoding and wire.body are page/chat only");
      }
      // ADR-033 #5/#6: every channel mode other than identical copies is `undefined` tier.
      if (!isBothChannels(e.wire.channels) && e.tier !== "undefined") {
        issue("tier", "a wire.channels entry other than both is tier undefined");
      }
    }
    if (e.challenge === undefined && e.accept_patch === undefined && e.wire === undefined) {
      issue("challenge", "a mutation needs a challenge, accept_patch or wire override");
    }
    if (e.accept_patch !== undefined && e.wire?.patch?.accepts !== undefined) {
      issue("accept_patch", "accept_patch and wire.patch.accepts both write the accepts array");
    }
  });
export type CatalogueEntry = z.infer<typeof CatalogueEntrySchema>;

export class CatalogueError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "CatalogueError";
  }
}

export interface Catalogue {
  /** Every entry, in id order. */
  entries: CatalogueEntry[];
  /** family -> its base entry. */
  bases: Map<string, CatalogueEntry>;
  /** sha256-input of the files (relative path + text), so the manifest can pin the input. */
  sources: { file: string; text: string }[];
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(?:ya?ml|json)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/** Loads and validates a catalogue directory. Throws `CatalogueError` on the first problem. */
export function loadCatalogue(dir: string): Catalogue {
  const files = walk(dir).sort((a, b) => compareCodeUnits(relative(dir, a), relative(dir, b)));
  if (files.length === 0)
    throw new CatalogueError(dir, "no catalogue entries (*.yaml, *.yml, *.json)");
  const entries: CatalogueEntry[] = [];
  const sources: { file: string; text: string }[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const rel = relative(dir, file);
    const text = readFileSync(file, "utf8");
    sources.push({ file: rel, text });
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch (err) {
      throw new CatalogueError(
        rel,
        `parse error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const result = CatalogueEntrySchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue ? issue.path.map(String).join(".") : "";
      throw new CatalogueError(
        rel,
        `${path === "" ? "" : `${path}: `}${issue?.message ?? "invalid"}`,
      );
    }
    const prior = seen.get(result.data.id);
    if (prior !== undefined) {
      throw new CatalogueError(rel, `duplicate id "${result.data.id}" also in ${prior}`);
    }
    seen.set(result.data.id, rel);
    entries.push(result.data);
  }
  entries.sort((a, b) => compareCodeUnits(a.id, b.id));

  const bases = new Map<string, CatalogueEntry>();
  for (const e of entries) {
    if (e.base !== true) continue;
    if (bases.has(e.family)) {
      throw new CatalogueError(seen.get(e.id) ?? e.id, `family "${e.family}" has two base entries`);
    }
    bases.set(e.family, e);
  }
  for (const e of entries) {
    if (e.base !== true && !bases.has(e.family)) {
      throw new CatalogueError(
        seen.get(e.id) ?? e.id,
        `family "${e.family}" has no base entry (every family needs its unmutated control)`,
      );
    }
  }
  return { entries, bases, sources };
}
