/**
 * Tool-handler tests against a live (offline, mock) adversary, per U12
 * functional-design.md §6 "Offline CI: ... tool-handler tests". Uses the real corpus's
 * `control-paid-fetch` scenario (a single fair-price paywalled endpoint) so
 * `http_get`/`pay_and_get`/`send_usdc` exercise the real challenge/verify/settle path.
 */

import { type Adversary, createAdversary } from "@x402-redteam/adversary";
import { capture } from "@x402-redteam/capture";
import { type Chain, canaries, type Scenario } from "@x402-redteam/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createToolHandlers,
  createUrlGuard,
  fetchFollowingRedirects,
  REFUSED_MESSAGE,
  REFUSED_RESULT,
  RedirectError,
  RefusedError,
} from "../src/lib/llm-tools.js";
import type { TaskFile } from "../src/lib/wallet.js";
import { buildLiveTask, loadScenarioById, SEED } from "./helpers/live-task.js";

const CHAINS: Chain[] = ["evm", "svm"];

describe.each(CHAINS)("llm-tools handlers (%s)", (chain) => {
  let adversary: Adversary;
  let scenario: Scenario;
  let task: TaskFile;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture });
    scenario = loadScenarioById("control-paid-fetch");
  });

  afterAll(async () => {
    await adversary.close();
  });

  afterEach(() => {
    adversary.drain();
  });

  function load(runId: string): void {
    adversary.load({ scenario, chain, run_id: `${chain}-llm-tools-${runId}` });
    task = buildLiveTask(scenario, chain, adversary.baseUrl);
  }

  it("http_get reports the 402 challenge without paying", async () => {
    load("http-get");
    const handlers = createToolHandlers(task);

    const raw = await handlers.http_get({ url: `${task.base_url}/api/report` });
    const result = JSON.parse(raw);

    expect(result.status).toBe(402);
    expect(result.accepts).toHaveLength(1);
    expect(result.accepts[0].amount_usd).toBeCloseTo(0.01, 6);
    expect(typeof result.accepts[0].pay_to).toBe("string");

    const drained = adversary.drain();
    expect(drained.payments).toHaveLength(0);
  });

  it("pay_and_get pays the challenge and returns the delivered body", async () => {
    load("pay-and-get");
    const handlers = createToolHandlers(task);

    const raw = await handlers.pay_and_get({ url: `${task.base_url}/api/report` });
    const result = JSON.parse(raw);

    expect(result.status).toBe(200);
    expect(result.body.length).toBeGreaterThan(0);

    const drained = adversary.drain();
    expect(drained.payments.length).toBeGreaterThanOrEqual(1);
    expect(drained.payments.every((p) => p.capture.includes("header"))).toBe(true);
  });

  it("http_get reports every redirect hop and the final URL", async () => {
    const redirect = loadScenarioById("recipient-redirect");
    adversary.load({ scenario: redirect, chain, run_id: `${chain}-llm-tools-redirect-get` });
    const redirectTask = buildLiveTask(redirect, chain, adversary.baseUrl);
    const handlers = createToolHandlers(redirectTask);
    const start = `${redirectTask.base_url}/api/report`;

    const result = JSON.parse(await handlers.http_get({ url: start }));

    expect(result.redirects).toHaveLength(1);
    expect(result.redirects[0].from).toBe(start);
    expect(result.final_url).not.toBe(start);
    expect(result.final_url).toBe(result.redirects.at(-1).to);
    expect(adversary.drain().payments).toHaveLength(0);
  });

  it("pay_and_get reports the final URL it paid at after a redirect", async () => {
    const redirect = loadScenarioById("recipient-redirect");
    adversary.load({ scenario: redirect, chain, run_id: `${chain}-llm-tools-redirect-pay` });
    const redirectTask = buildLiveTask(redirect, chain, adversary.baseUrl);
    const handlers = createToolHandlers(redirectTask);
    const start = `${redirectTask.base_url}/api/report`;

    const result = JSON.parse(await handlers.pay_and_get({ url: start }));

    expect(result.redirects).toHaveLength(1);
    expect(result.final_url).not.toBe(start);
    expect(adversary.drain().payments).toHaveLength(1);
  });

  it("pay_and_get follows a two-hop chain and pays once at its end", async () => {
    const twoHop = loadScenarioById("recipient-redirect-2");
    adversary.load({ scenario: twoHop, chain, run_id: `${chain}-llm-tools-redirect-2` });
    const twoHopTask = buildLiveTask(twoHop, chain, adversary.baseUrl);
    const handlers = createToolHandlers(twoHopTask);
    const start = `${twoHopTask.base_url}/api/invoice`;

    const result = JSON.parse(await handlers.pay_and_get({ url: start }));

    expect(result.redirects).toHaveLength(2);
    expect(result.final_url).toBe(result.redirects[1].to);
    expect(adversary.drain().payments).toHaveLength(1);
  });

  it("pay_and_get pays after a same-host redirect", async () => {
    const sameHost = loadScenarioById("control-same-host-redirect");
    adversary.load({ scenario: sameHost, chain, run_id: `${chain}-llm-tools-same-host` });
    const sameHostTask = buildLiveTask(sameHost, chain, adversary.baseUrl);
    const handlers = createToolHandlers(sameHostTask);

    const result = JSON.parse(
      await handlers.pay_and_get({ url: `${sameHostTask.base_url}/api/report` }),
    );

    expect(result.status).toBe(200);
    expect(result.final_url).toBe(`${sameHostTask.base_url}/v2/report`);
    expect(adversary.drain().payments).toHaveLength(1);
  });

  it("reports the requested URL as final and no redirects when none happen", async () => {
    load("no-redirect");
    const handlers = createToolHandlers(task);
    const url = `${task.base_url}/api/report`;
    const result = JSON.parse(await handlers.http_get({ url }));
    expect(result.final_url).toBe(url);
    expect(result.redirects).toEqual([]);
  });

  it("send_usdc sends a real direct transfer observed at the chain boundary", async () => {
    load("send-usdc");
    const handlers = createToolHandlers(task);
    const canaryAddress = canaries(SEED, scenario.id, chain).get("legit").address;

    const raw = await handlers.send_usdc({ to: canaryAddress, amount_usd: 0.02 });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(true);
    expect(typeof result.tx).toBe("string");

    const drained = adversary.drain();
    expect(drained.payments.some((p) => p.capture.includes("rpc"))).toBe(true);
  });

  it("http_get and pay_and_get report a network error instead of throwing", async () => {
    load("network-error");
    // An allowed origin (a declared host) that refuses connections, so this reaches the
    // network-error path and not the origin check (U30-5 N2).
    const down = { ...task, hosts: { "down.test": "http://127.0.0.1:1" } };
    const handlers = createToolHandlers(down);

    const raw = await handlers.http_get({ url: "http://127.0.0.1:1/unreachable" });
    const result = JSON.parse(raw);
    expect(typeof result.error).toBe("string");
    expect(result.error).not.toBe(REFUSED_MESSAGE);
    const paid = JSON.parse(await handlers.pay_and_get({ url: "http://127.0.0.1:1/unreachable" }));
    expect(typeof paid.error).toBe("string");
    expect(paid.error).not.toBe(REFUSED_MESSAGE);
  });

  it("http_get and pay_and_get refuse a URL outside the task's origins and send no request", async () => {
    load("refused");
    const lines: string[] = [];
    const handlers = createToolHandlers(task, { log: (line) => lines.push(line) });
    const fetchSpy = vi.fn(async () => new Response("x"));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      for (const url of ["https://example.com/x", "http://127.0.0.1:1/unreachable", "not a url"]) {
        expect(await handlers.http_get({ url })).toBe(REFUSED_RESULT);
        expect(await handlers.pay_and_get({ url })).toBe(REFUSED_RESULT);
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines).toContain("llm: refused https://example.com");
    expect(lines).toContain("llm: refused http://127.0.0.1:1");
    expect(adversary.drain().payments).toHaveLength(0);
  });

  it("http_get and pay_and_get refuse a redirect hop that leaves the task's origins", async () => {
    load("refused-hop");
    const lines: string[] = [];
    const handlers = createToolHandlers(task, { log: (line) => lines.push(line) });
    const start = `${task.base_url}/api/report`;
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://example.com/x" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      for (const tool of ["http_get", "pay_and_get"] as const) {
        fetchSpy.mockClear();
        const result = JSON.parse(await handlers[tool]({ url: start }));
        expect(result.error).toBe(REFUSED_MESSAGE);
        expect(result.redirects).toEqual([
          { status: 302, from: start, to: "https://example.com/x" },
        ]);
        // Only the first URL was requested; the hop was refused before it was fetched.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(lines.filter((l) => l === "llm: refused https://example.com")).toHaveLength(2);
  });
});

describe("fetchFollowingRedirects", () => {
  const res = (status: number, headers: Record<string, string> = {}) =>
    new Response(null, { status, headers });

  it("stops at a redirect that carries a payment receipt", async () => {
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      if (url.endsWith("/a")) return res(302, { location: "/b", "payment-response": "x" });
      return res(402);
    };
    const out = await fetchFollowingRedirects(fetchFn, "http://h.test/a");
    expect(calls).toEqual(["http://h.test/a"]);
    expect(out.res.status).toBe(302);
    expect(out.finalUrl).toBe("http://h.test/a");
    expect(out.redirects).toEqual([
      { status: 302, from: "http://h.test/a", to: "http://h.test/b" },
    ]);
  });

  it("checks every URL before it is fetched, the first and each hop", async () => {
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      return url.endsWith("/a")
        ? res(302, { location: "/b" })
        : res(302, { location: "http://evil.test/c" });
    };
    const lines: string[] = [];
    const guard = createUrlGuard({ base_url: "http://h.test" }, (l) => lines.push(l));
    const allows = (u: string) => guard.allows(u);

    const err = await fetchFollowingRedirects(fetchFn, "http://h.test/a", allows).catch((e) => e);
    expect(err).toBeInstanceOf(RefusedError);
    expect(err.message).toBe(REFUSED_MESSAGE);
    expect(err.redirects.map((h: { to: string }) => h.to)).toEqual([
      "http://h.test/b",
      "http://evil.test/c",
    ]);
    expect(calls).toEqual(["http://h.test/a", "http://h.test/b"]);
    expect(lines).toEqual(["llm: refused http://evil.test"]);

    const first = await fetchFollowingRedirects(fetchFn, "http://evil.test/a", allows).catch(
      (e) => e,
    );
    expect(first).toBeInstanceOf(RefusedError);
    expect(calls).toHaveLength(2);
  });

  it("the guard matches the exact origin, and an MCP URL must end in /mcp", () => {
    const guard = createUrlGuard({ base_url: "http://h.test:9000" }, () => {});
    expect(guard.allows("http://h.test:9000/x")).toBe(true);
    expect(guard.allows("http://h.test:9001/x")).toBe(false);
    expect(guard.allows("http://h.test:9000.evil.test/x")).toBe(false);
    expect(guard.allows("http://h.test:9000@evil.test/x")).toBe(false);
    expect(guard.allows(undefined)).toBe(false);
    expect(guard.allows("http://h.test:9000/mcp", { mcp: true })).toBe(true);
    expect(guard.allows("http://h.test:9000/_host/a.test/mcp", { mcp: true })).toBe(true);
    expect(guard.allows("http://h.test:9000/mcp/x", { mcp: true })).toBe(false);
  });

  it("keeps the hops taken when the redirect limit is reached", async () => {
    const fetchFn = async () => res(302, { location: "/loop" });
    const err = await fetchFollowingRedirects(fetchFn, "http://h.test/loop").catch((e) => e);
    expect(err).toBeInstanceOf(RedirectError);
    expect(err.redirects.length).toBe(11);
  });
});
