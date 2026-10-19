import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { compareCodeUnits } from "./canonical.js";
import {
  type Chain,
  type ChallengeSpec,
  minPayments,
  requireDelivered,
  type Scenario,
  ScenarioSchema,
} from "./scenario.js";
import { collectVars, type RenderContext, render, renderJsonStrings } from "./template.js";
import {
  decodeBase64Json,
  headerValueProblem,
  WIRE_RAW_JSON_PREFIX,
  WIRE_RAW_PREFIX,
} from "./wire.js";

const CHAINS: readonly Chain[] = ["evm", "svm"];

// v3 (ADR-012 / lint rule 6, application-design.md "Contracts (v3, Bolt 6)"): in a
// proxy-capable corpus, every host must be under one of these IANA-reserved TLDs, or
// listed in `decoy-domains.txt` - a real DNS name the agent could actually resolve and
// hit, if it bypasses the harness's forward proxy.
const RESERVED_HOST_TLDS = [".test", ".example", ".invalid", ".localhost"];
const DECOY_DOMAINS_FILENAME = "decoy-domains.txt";

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
  poison: (name) => `@@POISON_${name}@@`,
};

// v4 (U26-3): `{{lower:NAME}}` is canary NAME in lower case, the same recipient, so rule 3
// tracks it under the same key.
const CANARY_VAR_RE = /\{\{\s*(?:canary\.|lower:)([a-zA-Z0-9_-]+)\s*\}\}/g;
/** v4 (U26-3): any `{{lower:NAME}}` reference, for the EVM-only lint. */
const LOWER_VAR_RE = /\{\{\s*lower:/;
// v4 (U26-2, M4): the full poisoned address is a recipient like a canary, so rule 3
// tracks it under its own key. The short display forms never contain a full address.
const POISON_VAR_RE = /\{\{\s*poison:([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** Rule 3 keys: `NAME` for `{{canary.NAME}}`, `poison:NAME` for `{{poison:NAME}}`. */
function extractCanaryNames(template: string): string[] {
  return [
    ...[...template.matchAll(CANARY_VAR_RE)].map((m) => m[1] as string),
    ...[...template.matchAll(POISON_VAR_RE)].map((m) => `poison:${m[1] as string}`),
  ];
}

/** One `collectVars()` match against the `{{host:NAME}}` shape, for lint rule 6 (code
 * review item 7). */
const HOST_VAR_ARG_RE = /^\{\{\s*host:([a-zA-Z0-9_.-]+)\s*\}\}$/;

/**
 * Extracts every `{{host:NAME}}` reference's NAME from a template string via the shared
 * `collectVars()` (template.ts) - so this can never see a different variable set than
 * `render()` itself resolves.
 */
function hostNamesIn(template: string): string[] {
  const names: string[] = [];
  for (const variable of collectVars(template)) {
    const match = variable.match(HOST_VAR_ARG_RE);
    if (match) names.push(match[1] as string);
  }
  return names;
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
/** @internal shared with generator-lint.ts; not part of the public contract. */
export function payToFields(basePath: string, challenge: ChallengeSpec): TemplatedField[] {
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

/** U29-1 (ADR-032): the `wire` strings that reach the agent in the challenge header. */
/** @internal shared with generator-lint.ts; not part of the public contract. */
export function wireFields(
  basePath: string,
  challenge: ChallengeSpec | undefined,
): TemplatedField[] {
  const wire = challenge?.wire;
  if (wire === undefined) return [];
  const fields: TemplatedField[] = [];
  if (wire.patch !== undefined) {
    fields.push({ path: `${basePath}.wire.patch`, value: JSON.stringify(wire.patch) });
  }
  if (wire.encoding?.startsWith(WIRE_RAW_PREFIX)) {
    fields.push({
      path: `${basePath}.wire.encoding`,
      value: wire.encoding.slice(WIRE_RAW_PREFIX.length),
    });
  }
  if (wire.encoding?.startsWith(WIRE_RAW_JSON_PREFIX)) {
    fields.push({
      path: `${basePath}.wire.encoding`,
      value: wire.encoding.slice(WIRE_RAW_JSON_PREFIX.length),
    });
  }
  return fields;
}

/**
 * The text a `raw:` base64 header decodes to, when it decodes to JSON. The harness cannot
 * render templates inside base64, so this text is scanned for lint rules 3 and 6 but not
 * rendered.
 */
/** @internal shared with generator-lint.ts; not part of the public contract. */
export function wireDecodedFields(
  basePath: string,
  challenge: ChallengeSpec | undefined,
): TemplatedField[] {
  const enc = challenge?.wire?.encoding;
  if (enc === undefined || !enc.startsWith(WIRE_RAW_PREFIX)) return [];
  const text = decodeBase64Json(enc.slice(WIRE_RAW_PREFIX.length));
  return text === null ? [] : [{ path: `${basePath}.wire.encoding (decoded)`, value: text }];
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
    // v5 (U29-1): wire patch and raw header are templated; the patch as its JSON text,
    // which is enough for rule 2 (render) and rule 6 (`{{host:}}` references).
    fields.push(...wireFields(`routes[${i}].challenge`, route.challenge));
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
    // v4 (U26-2, review L4): extensions go to the agent in the 402 header.
    if (route.challenge?.extensions !== undefined) {
      fields.push({
        path: `routes[${i}].challenge.extensions`,
        value: JSON.stringify(route.challenge.extensions),
      });
    }
    // v4 (U26-2): a sign request is served to the agent like a page.
    if (route.sign_request !== undefined) {
      fields.push({
        path: `routes[${i}].sign_request`,
        value: JSON.stringify(route.sign_request),
      });
    }
  });
  return fields;
}

/**
 * Lint rule 6 (code review item 7): every host this scenario could ever cause a request
 * to - a declared route's `host`, a `task.allowed_hosts` entry, and every
 * `{{host:NAME}}` reference anywhere in templated text (via `templatedFields` and
 * `pageTextFields`, so `body_json` is covered too) - each paired with a
 * `CorpusError`-ready path.
 */
function collectHostReferences(scenario: Scenario): { path: string; host: string }[] {
  const refs: { path: string; host: string }[] = [];
  for (const { path, value } of [...templatedFields(scenario), ...pageTextFields(scenario)]) {
    for (const host of hostNamesIn(value)) {
      refs.push({ path: `${path} ({{host:${host}}})`, host });
    }
  }
  scenario.routes.forEach((route, i) => {
    refs.push({ path: `routes[${i}].host`, host: route.host });
    for (const { path, value } of wireDecodedFields(`routes[${i}].challenge`, route.challenge)) {
      for (const host of hostNamesIn(value))
        refs.push({ path: `${path} ({{host:${host}}})`, host });
    }
  });
  (scenario.task.allowed_hosts ?? []).forEach((host, i) => {
    refs.push({ path: `task.allowed_hosts[${i}]`, host });
  });
  return refs;
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
 * Reads `<dir>/decoy-domains.txt` (one hostname per line, `#`-prefixed lines and blank
 * lines ignored), per lint rule 6. Missing file -> empty set, which is the shipped
 * default (`corpus/decoy-domains.txt` starts empty - adding a domain is a user decision).
 */
function readDecoyDomains(dir: string): ReadonlySet<string> {
  const file = join(dir, DECOY_DOMAINS_FILENAME);
  if (!existsSync(file)) return new Set();
  const domains = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    domains.add(trimmed.toLowerCase());
  }
  return domains;
}

/**
 * Lint rule 6: `host` is under a reserved TLD, or explicitly allow-listed as a decoy.
 * Decoy matching is EXACT (case-insensitive), not a suffix/subdomain match - a decoy
 * entry of "example.com" allows exactly "example.com", never "sub.example.com" (that
 * would need its own entry). A reserved-TLD match, by contrast, *is* a suffix match
 * (`.endsWith(tld)`), since every subdomain under `.test`/`.example`/`.invalid`/
 * `.localhost` is itself reserved.
 */
function isAllowedHost(host: string, decoyDomains: ReadonlySet<string>): boolean {
  const lower = host.toLowerCase();
  if (RESERVED_HOST_TLDS.some((tld) => lower.endsWith(tld))) return true;
  return decoyDomains.has(lower);
}

/**
 * Corpus lint rules from functional-design.md §2, rules 1 (filename half),
 * 2-5. Rule 1's uniqueness half is enforced by `loadCorpus`, which is the
 * only place with visibility across files.
 */
function lintScenario(
  file: string,
  scenario: Scenario,
  decoyDomains: ReadonlySet<string> = new Set(),
): void {
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
    // v4 (U26-2): extensions and sign requests are deep-templated the same way.
    const deep: [string, unknown][] = [
      [`routes[${i}].challenge.body_json`, route.challenge?.body_json],
      [`routes[${i}].challenge.extensions`, route.challenge?.extensions],
      [`routes[${i}].sign_request`, route.sign_request],
    ];
    for (const [path, value] of deep) {
      if (value === undefined) continue;
      try {
        renderJsonStrings(value, DUMMY_CTX);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new CorpusError(file, path, message);
      }
    }
  });

  // U29-1: a `raw:` header value has to be sendable as an HTTP header value, and a
  // `raw_json:` value has to render to a JSON object.
  scenario.routes.forEach((route, i) => {
    const enc = route.challenge?.wire?.encoding;
    const path = `routes[${i}].challenge.wire.encoding`;
    if (enc?.startsWith(WIRE_RAW_PREFIX)) {
      const problem = headerValueProblem(render(enc.slice(WIRE_RAW_PREFIX.length), DUMMY_CTX));
      if (problem !== null) throw new CorpusError(file, path, `raw header value ${problem}`);
    } else if (enc?.startsWith(WIRE_RAW_JSON_PREFIX)) {
      const text = render(enc.slice(WIRE_RAW_JSON_PREFIX.length), DUMMY_CTX);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new CorpusError(file, path, "raw_json must render to JSON text");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CorpusError(file, path, "raw_json must render to a JSON object");
      }
    }
  });

  lintCollectSignature(file, scenario);
  lintLowerCase(file, scenario);

  // ADR-004 canary channel separation: a canary used as a payment recipient must never
  // also appear in any page-visible text (`page`, `delivered_body` or, v2, `body_json`),
  // scenario-wide. v2 (code review M2): every payTo-like field is in scope, including
  // per_chain overrides on both the top-level challenge and each accepts[] entry.
  const payToCanaries = new Map<string, string>();
  scenario.routes.forEach((route, i) => {
    if (route.challenge === undefined) return;
    // v5 (U29-1): the wire patch and raw header are challenge-side text, so a canary in
    // one is a recipient canary for rule 3.
    const challengeSide = [
      ...payToFields(`routes[${i}].challenge`, route.challenge),
      ...wireFields(`routes[${i}].challenge`, route.challenge),
      ...wireDecodedFields(`routes[${i}].challenge`, route.challenge),
    ];
    for (const { path, value } of challengeSide) {
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

  // Lint rule 6 (ADR-012): every host this scenario references - a declared route's
  // `host`, a `task.allowed_hosts` entry, or a `{{host:NAME}}` reference anywhere in
  // templated text (code review item 7: a scenario can reference a virtual host purely
  // in prose/a link without ever declaring a route at it) - must be under a reserved
  // TLD or an explicitly allow-listed decoy domain. A corpus hostname that resolves on
  // the real internet is a safety hazard once an agent is run in `proxy` mode and
  // bypasses the harness's forward proxy.
  for (const { path, host } of collectHostReferences(scenario)) {
    if (!isAllowedHost(host, decoyDomains)) {
      throw new CorpusError(
        file,
        path,
        `host "${host}" is not under a reserved TLD (.test/.example/.invalid/.localhost) ` +
          "and is not listed in corpus/decoy-domains.txt (lint rule 6)",
      );
    }
  }

  // Lint rule 7 (ADR-016 reach/`reached`): `reach_class` is required on every attack
  // scenario and forbidden on a control, and (code review item 7) a control's routes
  // must never set `surface: true` either - that field only means anything alongside a
  // `reach_class`, which a control never has. A scenario with `reach_class` but no
  // `surface: true` route is only a warning - its `reached` is then `null`, which is a
  // valid (if less useful) shape, not a corpus error.
  if (scenario.category === "control") {
    if (scenario.reach_class !== undefined) {
      throw new CorpusError(
        file,
        "reach_class",
        'a "control" scenario must not set reach_class (lint rule 7)',
      );
    }
    const surfaceRouteIndex = scenario.routes.findIndex((route) => route.surface === true);
    if (surfaceRouteIndex !== -1) {
      throw new CorpusError(
        file,
        `routes[${surfaceRouteIndex}].surface`,
        'a "control" scenario must not set surface: true on any route (lint rule 7)',
      );
    }
  } else {
    if (scenario.reach_class === undefined) {
      throw new CorpusError(
        file,
        "reach_class",
        `scenario "${scenario.id}" (category "${scenario.category}") must set reach_class (lint rule 7)`,
      );
    }
    if (!scenario.routes.some((route) => route.surface === true)) {
      console.warn(
        `x402-redteam: ${file}: scenario "${scenario.id}" has reach_class but no ` +
          'route with "surface: true" - its "reached" will be null (lint rule 7)',
      );
    }
  }
}

/**
 * v4 (U26-3): `{{lower:NAME}}` lower-cases an address, which names the same account only
 * on EVM (base58 is case-sensitive), so a scenario that uses it anywhere is EVM only.
 */
function lintLowerCase(file: string, scenario: Scenario): void {
  const used = LOWER_VAR_RE.test(
    JSON.stringify({ task: scenario.task, routes: scenario.routes, expected: scenario.expected }),
  );
  if (used && scenario.chains.some((chain) => chain !== "evm")) {
    throw new CorpusError(
      file,
      "chains",
      'a scenario that uses {{lower:NAME}} must set chains: ["evm"]',
    );
  }
}

/**
 * v4 (U26-2, M2): `behaviour: collect_signature` and `sign_request` go together, such a
 * route serves the request itself (no x402 challenge), its submit path is not another
 * declared route, and the scenario is EVM only (every sign request kind is an EVM
 * signature).
 */
function lintCollectSignature(file: string, scenario: Scenario): void {
  const declared = new Set(scenario.routes.map((r) => routeKey(r.host, r.path)));
  scenario.routes.forEach((route, i) => {
    const collects = route.behaviour === "collect_signature";
    if (collects !== (route.sign_request !== undefined)) {
      throw new CorpusError(
        file,
        `routes[${i}].sign_request`,
        "sign_request is required on, and only allowed on, a collect_signature route",
      );
    }
    if (!collects || route.sign_request === undefined) return;
    if (route.challenge !== undefined) {
      throw new CorpusError(
        file,
        `routes[${i}].challenge`,
        "a collect_signature route serves a sign request, not an x402 challenge",
      );
    }
    if (!route.sign_request.submit_path.startsWith("/")) {
      throw new CorpusError(
        file,
        `routes[${i}].sign_request.submit_path`,
        "sign_request.submit_path must be a path starting with /",
      );
    }
    if (declared.has(routeKey(route.host, route.sign_request.submit_path))) {
      throw new CorpusError(
        file,
        `routes[${i}].sign_request.submit_path`,
        "sign_request.submit_path must not be another declared route",
      );
    }
    if (scenario.chains.some((chain) => chain !== "evm")) {
      throw new CorpusError(
        file,
        "chains",
        'a scenario with a collect_signature route must set chains: ["evm"]',
      );
    }
  });
}

/** Parses, zod-validates and lints a single scenario YAML file. */
export function loadScenario(
  file: string,
  decoyDomains: ReadonlySet<string> = new Set(),
): Scenario {
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
  lintScenario(file, scenario, decoyDomains);
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
  const files = walkYamlFiles(dir).sort((a, b) =>
    compareCodeUnits(relative(dir, a), relative(dir, b)),
  );
  // Lint rule 6: `<dir>/decoy-domains.txt`, read once and shared across every scenario
  // in this corpus (a decoy domain is a corpus-wide, user-approved allow-list entry, not
  // a per-scenario one).
  const decoyDomains = readDecoyDomains(dir);

  const scenarios: Scenario[] = [];
  const seenIds = new Map<string, string>();

  for (const file of files) {
    const scenario = loadScenario(file, decoyDomains);
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
