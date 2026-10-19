import { payToFields } from "./load.js";
import type { Scenario } from "./scenario.js";

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
    if (!allowed.has(route.host.toLowerCase())) {
      badHost(`routes[${i}].host`, `host "${route.host}" is not one of the task's hosts`);
    }
  }
  for (const [i, host] of (scenario.task.allowed_hosts ?? []).entries()) {
    if (!allowed.has(host.toLowerCase())) {
      badHost(`task.allowed_hosts[${i}]`, `host "${host}" is not one of the task's hosts`);
    }
  }

  const walked = [
    ...strings(scenario, ""),
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
