/**
 * U17 code review F1: a venv-free regression test for `examples/agents-py/url_utils.py`'s
 * origin-allowlist based `extract_urls`/`allowed_origins` - the Python mirror of
 * `lib/crawl.ts`'s own F1 fix. `url_utils.py` has zero third-party imports (unlike
 * `agent.py`, which needs `eth_account`/`x402` from the project-local venv), so this runs
 * unconditionally wherever a system `python3` exists - no `uv sync` required, unlike
 * `python-agent.test.ts`'s `.venv`-gated live-adversary smoke test.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AGENTS_PY_DIR = fileURLToPath(new URL("../../agents-py", import.meta.url));

function findPython3(): string | undefined {
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}

const python3 = findPython3();

/** Runs a Python snippet with `examples/agents-py` on `sys.path`, so `import url_utils`
 * resolves without needing the project's own venv. The snippet must `print(json.dumps(...))`
 * its result as the last line of stdout. */
function runPython(snippet: string): unknown {
  if (!python3) throw new Error("no system python3/python found");
  const result = spawnSync(python3, ["-c", snippet], {
    encoding: "utf8",
    cwd: AGENTS_PY_DIR,
  });
  if (result.status !== 0) {
    throw new Error(`python exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim());
}

describe.skipIf(!python3)("url_utils.py (system python3, no venv needed)", () => {
  it("extract_urls finds a base_url-prefixed URL", () => {
    const out = runPython(`
import json
from url_utils import allowed_origins, extract_urls
task = {"base_url": "http://127.0.0.1:4321"}
origins = allowed_origins(task)
print(json.dumps(extract_urls("Fetch http://127.0.0.1:4321/forecast now.", origins)))
`);
    expect(out).toEqual(["http://127.0.0.1:4321/forecast"]);
  });

  it("extract_urls finds a *.localhost URL whose origin is in task['hosts']", () => {
    const out = runPython(`
import json
from url_utils import allowed_origins, extract_urls
task = {
    "base_url": "http://127.0.0.1:4321",
    "hosts": {"weather-report.test": "http://weather-report.test.localhost:4321"},
}
origins = allowed_origins(task)
text = "Partner: http://weather-report.test.localhost:4321/forecast"
print(json.dumps(extract_urls(text, origins)))
`);
    expect(out).toEqual(["http://weather-report.test.localhost:4321/forecast"]);
  });

  // Code review F1 (HIGH, egress): same two evil forms as the TS crawl.test.ts.
  it("rejects http://a.localhost.evil.com/x (declared origin is a SUFFIX, not a match)", () => {
    const out = runPython(`
import json
from url_utils import allowed_origins, extract_urls
task = {
    "base_url": "http://127.0.0.1:4321",
    "hosts": {"weather-report.test": "http://weather-report.test.localhost:4321"},
}
origins = allowed_origins(task)
print(json.dumps(extract_urls("Click http://a.localhost.evil.com/x now.", origins)))
`);
    expect(out).toEqual([]);
  });

  it("rejects http://x.localhost-evil.com/y (declared origin is a PREFIX, not a match)", () => {
    const out = runPython(`
import json
from url_utils import allowed_origins, extract_urls
task = {
    "base_url": "http://127.0.0.1:4321",
    "hosts": {"weather-report.test": "http://weather-report.test.localhost:4321"},
}
origins = allowed_origins(task)
print(json.dumps(extract_urls("Click http://x.localhost-evil.com/y now.", origins)))
`);
    expect(out).toEqual([]);
  });

  it("accepts the real declared origin alongside both evil look-alikes in the same text", () => {
    const out = runPython(`
import json
from url_utils import allowed_origins, extract_urls
task = {
    "base_url": "http://127.0.0.1:4321",
    "hosts": {"weather-report.test": "http://weather-report.test.localhost:4321"},
}
origins = allowed_origins(task)
text = (
    "Real: http://weather-report.test.localhost:4321/forecast "
    "Evil1: http://a.localhost.evil.com/x "
    "Evil2: http://x.localhost-evil.com/y"
)
print(json.dumps(extract_urls(text, origins)))
`);
    expect(out).toEqual(["http://weather-report.test.localhost:4321/forecast"]);
  });
});
