import { payToFields, wireDecodedFields } from "./load.js";
import type { Scenario } from "./scenario.js";
import { WIRE_RAW_JSON_PREFIX } from "./wire.js";

/**
 * Generator lint (U29-00, functional-design §8 condition 3; rules only, no I/O). The fuzz
 * generator (U29-2) calls this on every scenario it emits and refuses any violation.
 *
 * - Every `pay_to` (top-level, per-chain, and each `accepts[]` entry) is exactly one
 *   `{{canary.NAME}}`, `{{poison:NAME}}` or `{{lower:NAME}}` template (the last is a canary
 *   in lower case): never a literal address, never text around the template.
 * - Every host the scenario could cause a request to is one of the task's hosts: a route
 *   `host`, a `task.allowed_hosts` entry, a `{{host:NAME}}` reference, or the host of a
 *   literal absolute URL. These are found by walking EVERY string in the scenario object
 *   (prompt, pages, `body_json`, `extensions`, `sign_request`, redirects, ...), not a list
 *   of known fields, so a new string field is covered automatically.
 *
 * `extra` is the hook for data that is not part of the scenario object yet: U29-1's wire
 * patches and any raw header or body strings the generator will send. Each entry is walked
 * the same way under its key as the path prefix.
 *
 * Pure: returns the violations (empty when clean), in a stable order.
 */
export interface GeneratorLintViolation {
  rule: "pay-to" | "host";
  path: string;
  message: string;
}

const PAY_TO_TEMPLATE_RE =
  /^\{\{(?:canary\.[a-zA-Z0-9_-]+|lower:[a-zA-Z0-9_-]+|poison:[a-zA-Z0-9_.-]+)\}\}$/;
const HOST_VAR_RE = /\{\{\s*host:([a-zA-Z0-9_.-]+)\s*\}\}/g;
const LITERAL_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/([^/\s"'<>)\]\\?#:]+)/gi;

const LITERAL_EVM_ADDRESS_RE = /0x[0-9a-fA-F]{40}/;

/** Every `payTo` string reachable in a wire patch (any depth), with its path. */
function* patchPayTos(value: unknown, path: string): Generator<{ path: string; value: string }> {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* patchPayTos(v, `${path}[${i}]`);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "payTo" && typeof v === "string") yield { path: `${path}.${k}`, value: v };
      else yield* patchPayTos(v, `${path}.${k}`);
    }
  }
}

/** Every string leaf of `value` with its path. */
function* strings(value: unknown, path: string): Generator<{ path: string; value: string }> {
  if (typeof value === "string") yield { path, value };
  else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i}]`);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* strings(v, path === "" ? k : `${path}.${k}`);
  }
}

/** `taskHosts`: the virtual host names the generator's task may use (e.g. `provider.test`). */
export function lintGeneratedScenario(
  scenario: Scenario,
  taskHosts: readonly string[],
  extra: Readonly<Record<string, unknown>> = {},
): GeneratorLintViolation[] {
  const allowed = new Set(taskHosts.map((h) => h.toLowerCase()));
  const out: GeneratorLintViolation[] = [];
  const badHost = (path: string, message: string) => out.push({ rule: "host", path, message });

  for (const [i, route] of scenario.routes.entries()) {
    if (route.challenge) {
      for (const { path, value } of payToFields(`routes[${i}].challenge`, route.challenge)) {
        if (!PAY_TO_TEMPLATE_RE.test(value.trim())) {
          out.push({
            rule: "pay-to",
            path,
            message:
              "pay_to must be exactly a {{canary.NAME}}, {{lower:NAME}} or {{poison:NAME}} template",
          });
        }
      }
    }
    // U29-1: a wire patch's `payTo` strings follow the same rule as `pay_to`, and a
    // `raw:` header never embeds a literal EVM address.
    const wire = route.challenge?.wire;
    if (wire?.patch !== undefined) {
      for (const { path, value } of patchPayTos(wire.patch, `routes[${i}].challenge.wire.patch`)) {
        if (!PAY_TO_TEMPLATE_RE.test(value.trim())) {
          out.push({
            rule: "pay-to",
            path,
            message:
              "a wire patch payTo must be exactly a {{canary.NAME}}, {{lower:NAME}} or {{poison:NAME}} template",
          });
        }
      }
    }
    // A raw_json: or base64 raw: header is parsed, and its payTo values follow the same rule.
    const embedded: unknown[] = [];
    if (wire?.encoding?.startsWith(WIRE_RAW_JSON_PREFIX)) {
      try {
        embedded.push(JSON.parse(wire.encoding.slice(WIRE_RAW_JSON_PREFIX.length)));
      } catch {
        // not JSON: load lint reports it
      }
    }
    for (const { value } of wireDecodedFields(`routes[${i}].challenge`, route.challenge)) {
      embedded.push(JSON.parse(value));
    }
    for (const obj of embedded) {
      for (const { path, value } of patchPayTos(obj, `routes[${i}].challenge.wire.encoding`)) {
        if (!PAY_TO_TEMPLATE_RE.test(value.trim())) {
          out.push({
            rule: "pay-to",
            path,
            message:
              "a wire header payTo must be exactly a {{canary.NAME}}, {{lower:NAME}} or {{poison:NAME}} template",
          });
        }
      }
    }
    if (wire?.encoding?.startsWith("raw:") && LITERAL_EVM_ADDRESS_RE.test(wire.encoding)) {
      out.push({
        rule: "pay-to",
        path: `routes[${i}].challenge.wire.encoding`,
        message: "a raw: header must not embed a literal address; use a canary template",
      });
    }
    if (!allowed.has(route.host.toLowerCase())) {
      badHost(`routes[${i}].host`, `host "${route.host}" is not one of the task's hosts`);
    }
  }
  for (const [i, host] of (scenario.task.allowed_hosts ?? []).entries()) {
    if (!allowed.has(host.toLowerCase())) {
      badHost(`task.allowed_hosts[${i}]`, `host "${host}" is not one of the task's hosts`);
    }
  }

  const decoded = scenario.routes.flatMap((route, i) =>
    wireDecodedFields(`routes[${i}].challenge`, route.challenge),
  );
  const walked = [
    ...strings(scenario, ""),
    ...decoded,
    ...Object.entries(extra).flatMap(([key, v]) => [...strings(v, key)]),
  ];
  for (const { path, value } of walked) {
    for (const m of value.matchAll(HOST_VAR_RE)) {
      const host = m[1] as string;
      if (!allowed.has(host.toLowerCase())) {
        badHost(`${path} ({{host:${host}}})`, `host "${host}" is not one of the task's hosts`);
      }
    }
    for (const m of value.matchAll(LITERAL_URL_RE)) {
      const host = (m[1] as string).toLowerCase();
      if (!allowed.has(host)) {
        badHost(path, `literal URL host "${host}" is not one of the task's hosts`);
      }
    }
  }
  return out;
}
