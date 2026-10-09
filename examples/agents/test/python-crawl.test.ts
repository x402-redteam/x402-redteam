/**
 * A venv-free test for `examples/agents-py/crawl.py`, the Python mirror of `lib/crawl.ts`:
 * redirects and page links are followed only within the declared origins, breadth-first,
 * up to depth 3 and 30 fetches in total. `crawl.py` has no third-party imports, so this
 * runs wherever a system `python3` exists. The HTTP function is a scripted fake.
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

/** Crawls `seeds` against a fake site and prints the fetched URLs and returned pages. */
function crawlFake(
  site: Record<string, [number, string, string?]>,
  seeds: string[],
  origins: string[],
) {
  if (!python3) throw new Error("no system python3/python found");
  const snippet = `
import asyncio, json, sys
from crawl import crawl
site = json.loads(sys.argv[1]); seeds = json.loads(sys.argv[2]); origins = set(json.loads(sys.argv[3]))
requested = []
class Resp:
    def __init__(self, status, body, location):
        self.status_code = status; self.text = body
        self.headers = {"location": location} if location else {}
async def get(url):
    requested.append(url)
    status, body, *rest = site.get(url, [404, "", None])
    return Resp(status, body, rest[0] if rest else None)
pages = asyncio.run(crawl(get, seeds, origins))
print(json.dumps({"requested": requested, "pages": [[p.url, p.status] for p in pages]}))
`;
  const result = spawnSync(
    python3,
    ["-c", snippet, JSON.stringify(site), JSON.stringify(seeds), JSON.stringify(origins)],
    { encoding: "utf8", cwd: AGENTS_PY_DIR },
  );
  if (result.status !== 0) throw new Error(`python exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim()) as { requested: string[]; pages: [string, number][] };
}

const P = "http://provider.test.localhost:4000";
const Q = "http://partner.test.localhost:4000";

describe.skipIf(!python3)("crawl.py (system python3, no venv needed)", () => {
  it("follows a same-origin redirect to the page it points at", () => {
    const out = crawlFake(
      { [`${P}/a`]: [302, "", "/b"], [`${P}/b`]: [200, "ok"] },
      [`${P}/a`],
      [P],
    );
    expect(out.requested).toEqual([`${P}/a`, `${P}/b`]);
    expect(out.pages).toEqual([[`${P}/b`, 200]]);
  });

  it("follows a link on a fetched page to another declared origin", () => {
    const out = crawlFake(
      {
        [`${P}/news`]: [200, `see ${Q}/data/full for the rest`],
        [`${Q}/data/full`]: [200, "data"],
      },
      [`${P}/news`],
      [P, Q],
    );
    expect(out.requested).toEqual([`${P}/news`, `${Q}/data/full`]);
  });

  it("never requests an origin that was not declared, by link or by redirect", () => {
    const out = crawlFake(
      {
        [`${P}/a`]: [200, "go to http://evil.test.localhost:4000/x"],
        [`${P}/b`]: [302, "", "http://evil.test.localhost:4000/y"],
      },
      [`${P}/a`, `${P}/b`],
      [P],
    );
    expect(out.requested).toEqual([`${P}/a`, `${P}/b`]);
  });

  it("stops at depth 3", () => {
    const site: Record<string, [number, string]> = {};
    for (let i = 0; i < 6; i++) site[`${P}/p${i}`] = [200, `next ${P}/p${i + 1}`];
    const out = crawlFake(site, [`${P}/p0`], [P]);
    expect(out.requested).toEqual([`${P}/p0`, `${P}/p1`, `${P}/p2`, `${P}/p3`]);
  });

  it("stops after 30 fetches, counting redirect hops", () => {
    // Five seeds, each a redirect loop of up to 10 hops: 50 requests without the cap.
    const seeds = [0, 1, 2, 3, 4].map((i) => `${P}/loop${i}`);
    const site: Record<string, [number, string, string]> = {};
    for (const [i, seed] of seeds.entries()) site[seed] = [302, "", `/loop${i}`];
    const out = crawlFake(site, seeds, [P]);
    expect(out.requested).toHaveLength(30);
    expect(out.pages).toEqual([]);
  });

  it("fetches each discovered link once, and a seed again only when a page links back to it", () => {
    const out = crawlFake(
      { [`${P}/a`]: [200, `${P}/b and ${P}/b again`], [`${P}/b`]: [200, `${P}/a`] },
      [`${P}/a`],
      [P],
    );
    expect(out.requested).toEqual([`${P}/a`, `${P}/b`, `${P}/a`]);
  });
});
