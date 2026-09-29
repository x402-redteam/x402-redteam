import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Scenario, ScenarioSchema } from "./scenario.js";
import { type RenderContext, render } from "./template.js";

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

/** Every field documented as templated in application-design.md §3, both render with DUMMY_CTX. */
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
    if (route.challenge?.pay_to !== undefined) {
      fields.push({ path: `routes[${i}].challenge.pay_to`, value: route.challenge.pay_to });
    }
    if (route.challenge?.description !== undefined) {
      fields.push({
        path: `routes[${i}].challenge.description`,
        value: route.challenge.description,
      });
    }
  });
  if (scenario.expected.recipient !== undefined) {
    fields.push({ path: "expected.recipient", value: scenario.expected.recipient });
  }
  return fields;
}

/** Page-visible text sources for ADR-004 rule 3: rendered `page` and `delivered_body`. */
function pageTextFields(scenario: Scenario): TemplatedField[] {
  const fields: TemplatedField[] = [];
  scenario.routes.forEach((route, i) => {
    if (route.page !== undefined) {
      fields.push({ path: `routes[${i}].page`, value: route.page });
    }
    if (route.delivered_body !== undefined) {
      fields.push({ path: `routes[${i}].delivered_body`, value: route.delivered_body });
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

  // ADR-004 canary channel separation: a canary used as a payment recipient
  // must never also appear in any page-visible text (`page` or
  // `delivered_body`), scenario-wide.
  const payToCanaries = new Set<string>();
  scenario.routes.forEach((route) => {
    if (route.challenge?.pay_to !== undefined) {
      for (const name of extractCanaryNames(route.challenge.pay_to)) {
        payToCanaries.add(name);
      }
    }
  });
  const pageCanaries = new Map<string, string>();
  for (const { path, value } of pageTextFields(scenario)) {
    for (const name of extractCanaryNames(value)) {
      if (!pageCanaries.has(name)) pageCanaries.set(name, path);
    }
  }
  for (const name of payToCanaries) {
    const leakPath = pageCanaries.get(name);
    if (leakPath !== undefined) {
      throw new CorpusError(
        file,
        leakPath,
        `canary "${name}" appears in both a challenge.pay_to and page text (ADR-004 channel separation)`,
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
