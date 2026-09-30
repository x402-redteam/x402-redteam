import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type Chain,
  type ChallengeSpec,
  minPayments,
  requireDelivered,
  type Scenario,
  ScenarioSchema,
} from "./scenario.js";
import { type RenderContext, render, renderJsonStrings } from "./template.js";

const CHAINS: readonly Chain[] = ["evm", "svm"];

/** Corpus loading / lint error. `path` is a dotted/bracketed path into the YAML document. */
export class CorpusError extends Error {
  readonly file: string;
  readonly path: string;

  constructor(file: string, path: string, message: string) {
    super(message);
    this.name = "CorpusError";
    this.file = file;
    this.path = path;
  }
}

// A deterministic, inert context used only to check that every template
// variable resolves and, for redirects, to resolve which (host, path) a
// rendered redirect target points at. The literal marker strings below are
// never meant to be user-visible; they only need to be recognizable.
const BASE_MARKER = "@@BASE@@";
const DUMMY_CTX: RenderContext = {
  base_url: BASE_MARKER,
  chain: "evm",
  network: "eip155:0",
  usdc: "0xUSDC",
  host: (name) => `${BASE_MARKER}/_host/${name}`,
  canary: (name) => `@@CANARY_${name}@@`,
};

const CANARY_VAR_RE = /\{\{\s*canary\.([a-zA-Z0-9_-]+)\s*\}\}/g;

function extractCanaryNames(template: string): string[] {
  return [...template.matchAll(CANARY_VAR_RE)].map((m) => m[1] as string);
}

interface TemplatedField {
  path: string;
  value: string;
}

/**
 * Every pay_to-like field on a challenge (code review M2): the top-level `pay_to`, its
 * `per_chain.{evm,svm}.pay_to` overrides, and - v2 (accepts_ordering) - each
 * `accepts[]` entry's `pay_to` and its own `per_chain.{evm,svm}.pay_to` overrides.
 * Every one of these is both templated (rule 2) and a payment recipient scanned for
 * ADR-004 channel separation (rule 3), so both rules share this single source of paths.
 */
function payToFields(basePath: string, challenge: ChallengeSpec): TemplatedField[] {
  const fields: TemplatedField[] = [];
  if (challenge.pay_to !== undefined) {
    fields.push({ path: `${basePath}.pay_to`, value: challenge.pay_to });
  }
  for (const chain of CHAINS) {
    const override = challenge.per_chain?.[chain];
    if (override?.pay_to !== undefined) {
      fields.push({ path: `${basePath}.per_chain.${chain}.pay_to`, value: override.pay_to });
    }
  }
  challenge.accepts?.forEach((accept, j) => {
    const acceptPath = `${basePath}.accepts[${j}]`;
    fields.push({ path: `${acceptPath}.pay_to`, value: accept.pay_to });
    for (const chain of CHAINS) {
      const override = accept.per_chain?.[chain];
      if (override?.pay_to !== undefined) {
        fields.push({ path: `${acceptPath}.per_chain.${chain}.pay_to`, value: override.pay_to });
      }
    }
  });
  return fields;
}

/**
 * Every plain-string field documented as templated in application-design.md §3, each
 * rendered with DUMMY_CTX. `body_json` (v2 challenge_injection) is deep-templated, not a
 * single string, so it's checked separately in `lintScenario` via `renderJsonStrings`
 * (code review L6) rather than being collected here.
 */
function templatedFields(scenario: Scenario): TemplatedField[] {
  const fields: TemplatedField[] = [{ path: "task.prompt", value: scenario.task.prompt }];
  scenario.routes.forEach((route, i) => {
    if (route.page !== undefined) {
      fields.push({ path: `routes[${i}].page`, value: route.page });
    }
    if (route.redirect !== undefined) {
      fields.push({ path: `routes[${i}].redirect`, value: route.redirect });
    }
    if (route.delivered_body !== undefined) {
      fields.push({ path: `routes[${i}].delivered_body`, value: route.delivered_body });
    }
    if (route.challenge !== undefined) {
      fields.push(...payToFields(`routes[${i}].challenge`, route.challenge));
    }
    if (route.challenge?.description !== undefined) {
      fields.push({
        path: `routes[${i}].challenge.description`,
        value: route.challenge.description,
      });
    }
    // v2 (resource_spoof): templated, overrides PaymentRequired.resource.url.
    if (route.challenge?.resource_url !== undefined) {
      fields.push({
        path: `routes[${i}].challenge.resource_url`,
        value: route.challenge.resource_url,
      });
    }
  });
  if (scenario.expected.recipient !== undefined) {
    fields.push({ path: "expected.recipient", value: scenario.expected.recipient });
  }
  return fields;
}

/**
 * Page-visible text sources for ADR-004 rule 3: rendered `page` and `delivered_body`.
 * `body_json` (v2) also "counts as page-visible text for rule 3" (application-design.md
 * §3 "v2") - represented here as its whole JSON.stringify'd (unrendered) text, which is
 * enough for a `{{canary.X}}` substring scan regardless of nesting depth.
 */
function pageTextFields(scenario: Scenario): TemplatedField[] {
  const fields: TemplatedField[] = [];
  scenario.routes.forEach((route, i) => {
    if (route.page !== undefined) {
      fields.push({ path: `routes[${i}].page`, value: route.page });
    }
    if (route.delivered_body !== undefined) {
      fields.push({ path: `routes[${i}].delivered_body`, value: route.delivered_body });
    }
    if (route.challenge?.body_json !== undefined) {
      fields.push({
        path: `routes[${i}].challenge.body_json`,
        value: JSON.stringify(route.challenge.body_json),
      });
    }
  });
  return fields;
}

function resolveRedirectTarget(rendered: string): { host: string; path: string } | null {
  const hostPrefix = `${BASE_MARKER}/_host/`;
  if (rendered.startsWith(hostPrefix)) {
    const rest = rendered.slice(hostPrefix.length);
    const slashIdx = rest.indexOf("/");
    return slashIdx === -1
      ? { host: rest, path: "" }
      : { host: rest.slice(0, slashIdx), path: rest.slice(slashIdx) };
  }
  if (rendered.startsWith(BASE_MARKER)) {
    return { host: "provider.test", path: rendered.slice(BASE_MARKER.length) };
  }
  return null;
}

function routeKey(host: string, path: string): string {
  return `${host}\u0000${path}`;
}

/**
 * Corpus lint rules from functional-design.md §2, rules 1 (filename half),
 * 2-5. Rule 1's uniqueness half is enforced by `loadCorpus`, which is the
 * only place with visibility across files.
 */
function lintScenario(file: string, scenario: Scenario): void {
  const expectedId = basename(file, extname(file));
  if (scenario.id !== expectedId) {
    throw new CorpusError(
      file,
      "id",
      `scenario id "${scenario.id}" must match filename "${expectedId}"`,
    );
  }

  for (const { path, value } of templatedFields(scenario)) {
    try {
      render(value, DUMMY_CTX);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CorpusError(file, path, message);
    }
  }

  // v2 (challenge_injection): every string leaf of body_json is templated too, checked
  // via the shared `renderJsonStrings` (code review L6) rather than a hand-rolled walk.
  scenario.routes.forEach((route, i) => {
    if (route.challenge?.body_json === undefined) return;
    try {
      renderJsonStrings(route.challenge.body_json, DUMMY_CTX);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CorpusError(file, `routes[${i}].challenge.body_json`, message);
    }
  });

  // ADR-004 canary channel separation: a canary used as a payment recipient must never
  // also appear in any page-visible text (`page`, `delivered_body` or, v2, `body_json`),
  // scenario-wide. v2 (code review M2): every payTo-like field is in scope, including
  // per_chain overrides on both the top-level challenge and each accepts[] entry.
  const payToCanaries = new Map<string, string>();
  scenario.routes.forEach((route, i) => {
    if (route.challenge === undefined) return;
    for (const { path, value } of payToFields(`routes[${i}].challenge`, route.challenge)) {
      for (const name of extractCanaryNames(value)) {
        if (!payToCanaries.has(name)) payToCanaries.set(name, path);
      }
    }
  });
  const pageCanaries = new Map<string, string>();
  for (const { path, value } of pageTextFields(scenario)) {
    for (const name of extractCanaryNames(value)) {
      if (!pageCanaries.has(name)) pageCanaries.set(name, path);
    }
  }
  for (const [name, payToPath] of payToCanaries) {
    const leakPath = pageCanaries.get(name);
    if (leakPath !== undefined) {
      // Code review L5: name the actual payTo source (challenge.pay_to,
      // challenge.per_chain.evm.pay_to, challenge.accepts[j].pay_to, ...), not a fixed
      // "a challenge.pay_to" that stopped being accurate once per_chain/accepts joined.
      throw new CorpusError(
        file,
        leakPath,
        `canary "${name}" appears in both ${payToPath} and page text (ADR-004 channel separation)`,
      );
    }
  }

  if (scenario.expected.allow && scenario.expected.max_usd === undefined) {
    throw new CorpusError(
      file,
      "expected.max_usd",
      "expected.max_usd is required when expected.allow is true",
    );
  }

  // v2 (ADR-009 control lint, application-design.md §3 "v2"): a control scenario is a
  // legitimate job the guardrail must still complete - it keeps attack scenarios
  // passable by refusal by reserving min_payments > 0 for controls only.
  if (scenario.category === "control") {
    if (scenario.expected.allow !== true) {
      throw new CorpusError(
        file,
        "expected.allow",
        'a "control" scenario must have expected.allow: true',
      );
    }
    if (minPayments(scenario.expected) < 1) {
      throw new CorpusError(
        file,
        "expected.min_payments",
        'a "control" scenario must have expected.min_payments >= 1',
      );
    }
    // Code review L2: min_payments is a floor and max_payments a ceiling on the same
    // run - a control that requires more payments than it permits can never pass.
    if (minPayments(scenario.expected) > scenario.expected.max_payments) {
      throw new CorpusError(
        file,
        "expected.min_payments",
        `a "control" scenario's expected.min_payments (${minPayments(scenario.expected)}) must not exceed expected.max_payments (${scenario.expected.max_payments})`,
      );
    }
    if (!requireDelivered(scenario.expected)) {
      throw new CorpusError(
        file,
        "expected.require_delivered",
        'a "control" scenario must have expected.require_delivered: true',
      );
    }
  } else if (minPayments(scenario.expected) > 0) {
    throw new CorpusError(
      file,
      "expected.min_payments",
      `only a "control" scenario may set expected.min_payments > 0 (category "${scenario.category}")`,
    );
  }

  const declared = new Set(scenario.routes.map((r) => routeKey(r.host, r.path)));
  scenario.routes.forEach((route, i) => {
    if (route.redirect === undefined) return;
    const rendered = render(route.redirect, DUMMY_CTX);
    const target = resolveRedirectTarget(rendered);
    if (target === null || !declared.has(routeKey(target.host, target.path))) {
      throw new CorpusError(
        file,
        `routes[${i}].redirect`,
        `redirect target does not resolve to a declared route: "${route.redirect}"`,
      );
    }
  });
}

/** Parses, zod-validates and lints a single scenario YAML file. */
export function loadScenario(file: string): Scenario {
  const raw = readFileSync(file, "utf8");

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CorpusError(file, "", `YAML parse error: ${message}`);
  }

  const result = ScenarioSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue ? issue.path.map(String).join(".") : "";
    const message = issue ? issue.message : "invalid scenario";
    throw new CorpusError(file, path, message);
  }

  const scenario = result.data;
  lintScenario(file, scenario);
  return scenario;
}

function walkYamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkYamlFiles(full));
    } else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Loads and lints every `*.yaml`/`*.yml` scenario found anywhere under a
 * corpus directory (recursively, so scenarios may be grouped into
 * subdirectories by category). Files are visited in a deterministic order.
 */
export function loadCorpus(dir: string): Scenario[] {
  const files = walkYamlFiles(dir).sort((a, b) => relative(dir, a).localeCompare(relative(dir, b)));

  const scenarios: Scenario[] = [];
  const seenIds = new Map<string, string>();

  for (const file of files) {
    const scenario = loadScenario(file);
    const priorFile = seenIds.get(scenario.id);
    if (priorFile !== undefined) {
      throw new CorpusError(
        file,
        "id",
        `duplicate scenario id "${scenario.id}" also declared in "${priorFile}"`,
      );
    }
    seenIds.set(scenario.id, file);
    scenarios.push(scenario);
  }

  return scenarios;
}
