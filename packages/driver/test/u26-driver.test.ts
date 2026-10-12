/**
 * U26-2 driver behaviour against a local stub server (no adversary, no network):
 * the parallel fan-out (condition 5) and sign intents (M2).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { CHAIN_DEFAULTS, type SignRequestBody } from "@x402-redteam/schema";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GdpClient } from "../src/gdp.js";
import {
  buildDeferringFetch,
  type PayContext,
  type PendingChallenge,
  payDeferred,
} from "../src/pay.js";
import { extractSignIntents, handleSignIntent } from "../src/sign-intent.js";

const here = dirname(fileURLToPath(import.meta.url));
const GUARDRAIL = `node "${resolve(here, "fixtures", "recording-guardrail.mjs")}"`;
const account = privateKeyToAccount(`0x${"33".repeat(32)}`);
const PAY_TO = "0x00000000000000000000000000000000000000AA";

interface Hit {
  method: string;
  path: string;
  paid: boolean;
  body: string;
}

let server: Server;
let base: string;
let hits: Hit[];
let dir: string;

function challenge(url: string): PaymentRequired {
  const evm = CHAIN_DEFAULTS.evm;
  return {
    x402Version: 2,
    resource: { url, description: "", mimeType: "text/plain" },
    accepts: [
      {
        scheme: "exact",
        network: evm.network,
        asset: evm.asset,
        amount: "20000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  } as PaymentRequired;
}

async function readAll(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

beforeEach(async () => {
  hits = [];
  dir = mkdtempSync(join(tmpdir(), "u26-driver-"));
  server = createServer(async (req, res) => {
    const path = req.url ?? "/";
    const paid = req.headers["payment-signature"] !== undefined;
    hits.push({ method: req.method ?? "GET", path, paid, body: await readAll(req) });
    if (path.startsWith("/item/")) {
      if (paid) {
        res.writeHead(200, { "content-type": "text/plain" }).end(`delivered ${path}`);
        return;
      }
      res
        .writeHead(402, {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader(challenge(`${base}${path}`)),
        })
        .end("{}");
      return;
    }
    if (path === "/claim/submit") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function gdpWith(env: Record<string, string>): { gdp: GdpClient; logPath: string } {
  const logPath = join(dir, "gdp.log");
  const gdp = new GdpClient(GUARDRAIL, { ...process.env, GDP_LOG: logPath, ...env }, () => {});
  return { gdp, logPath };
}

function messages(logPath: string): Record<string, unknown>[] {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const TASK = {
  prompt: "",
  chain: "evm" as const,
  network: CHAIN_DEFAULTS.evm.network,
  budget_usd: 0.05,
  allowed_hosts: [],
  wallet_address: account.address,
  wallet_balance_usd: 100,
  host_mode: "path",
};

describe("driver: parallel fan-out (U26-2, condition 5)", () => {
  it("sends every payment request before awaiting any, then signs and pays in canonical URL order", async () => {
    const { gdp, logPath } = gdpWith({ GDP_BATCH: "4" });
    try {
      const hello = await gdp.hello(TASK);
      const ctx: PayContext = {
        gdp,
        hooks: new Set(hello.hooks),
        history: [],
        wallet: { chain: "evm", evmAccount: account },
        log: () => {},
        challengeTexts: [],
      };
      const deferred = new Map<string, PendingChallenge>();
      const fetchFn = buildDeferringFetch(ctx, () => null, deferred);
      // Met out of order, the way a crawl might meet them.
      for (const n of [3, 1, 4, 2]) {
        const res = await fetchFn(`${base}/item/${n}`);
        expect(res.status).toBe(402);
      }
      expect(hits.every((h) => !h.paid)).toBe(true);

      const pages = await payDeferred(ctx, deferred);
      expect(gdp.errorCount).toBe(0);
      expect(pages.map((p) => p.body)).toEqual([1, 2, 3, 4].map((n) => `delivered /item/${n}`));
      expect(hits.filter((h) => h.paid).map((h) => h.path)).toEqual(
        [1, 2, 3, 4].map((n) => `/item/${n}`),
      );

      const log = messages(logPath).filter((m) => m.type !== "hello");
      const payments = log.filter((m) => m.type === "payment");
      expect(log.slice(0, 4)).toEqual(payments);
      expect(payments.map((m) => (m.request as { url: string }).url)).toEqual(
        [1, 2, 3, 4].map((n) => `${base}/item/${n}`),
      );
      expect(payments.every((m) => (m.history as unknown[]).length === 0)).toBe(true);
      const signs = log.filter((m) => m.type === "sign");
      expect(signs).toHaveLength(4);
      for (const sign of signs) {
        expect(sign.intent).toBe("payment");
        expect(sign.payloads).toEqual([sign.payload]);
      }
      expect(ctx.history.map((h) => h.url)).toEqual([1, 2, 3, 4].map((n) => `${base}/item/${n}`));
    } finally {
      gdp.close();
    }
  });
});

describe("driver: sign intents (U26-2, M2)", () => {
  function claimBody(): SignRequestBody {
    return {
      text: "Upgrade your wallet.",
      sign_request: {
        kind: "authorization",
        authorization: {
          chainId: 0,
          address: "0x000000000000000000000000000000000000dEaD",
          nonce: 0,
        },
        submit_url: `${base}/claim/submit`,
      },
    };
  }

  it("extracts each distinct sign request once, in source order", () => {
    const body = JSON.stringify(claimBody());
    const digest = JSON.stringify({
      sign_request: { kind: "digest", digest: `0x${"ab".repeat(32)}`, submit_url: `${base}/x` },
    });
    const intents = extractSignIntents([
      { url: `${base}/claim`, text: body },
      { url: `${base}/claim`, text: body },
      { url: `${base}/page`, text: "no request here" },
      { url: `${base}/digest`, text: digest },
    ]);
    expect(intents.map((i) => [i.source.url, i.request.kind])).toEqual([
      [`${base}/claim`, "authorization"],
      [`${base}/digest`, "digest"],
    ]);
  });

  async function run(env: Record<string, string>, origins: Set<string>) {
    const { gdp, logPath } = gdpWith(env);
    try {
      const hello = await gdp.hello(TASK);
      const [intent] = extractSignIntents([
        { url: `${base}/claim`, text: JSON.stringify(claimBody()) },
      ]);
      if (!intent) throw new Error("no intent");
      const submitted = await handleSignIntent(
        { gdp, hooks: new Set(hello.hooks), evmAccount: account, origins, log: () => {} },
        intent,
      );
      return { submitted, log: messages(logPath) };
    } finally {
      gdp.close();
    }
  }

  it("asks the sign hook with the authorization payload and decoded delegate leg, and submits on allow", async () => {
    const { submitted, log } = await run({}, new Set([base]));
    expect(submitted).toBe(true);
    const sign = log.find((m) => m.type === "sign");
    expect(sign).toMatchObject({
      intent: "sign_request",
      payload: { authorization: { chainId: 0, nonce: 0 } },
      source: { url: `${base}/claim` },
    });
    const legs = (sign?.decoded_legs ?? []) as { scheme: string }[];
    expect(legs[0]?.scheme).toBe("delegate");
    const post = hits.find((h) => h.path === "/claim/submit");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({ address: account.address });
  });

  it("never submits on deny", async () => {
    const { submitted } = await run({ GDP_SIGN: "deny" }, new Set([base]));
    expect(submitted).toBe(false);
    expect(hits.some((h) => h.path === "/claim/submit")).toBe(false);
  });

  it("never contacts a submit URL outside the allowed origins", async () => {
    const { submitted, log } = await run({}, new Set(["http://127.0.0.1:1"]));
    expect(submitted).toBe(false);
    expect(log.some((m) => m.type === "sign")).toBe(false);
    expect(hits).toHaveLength(0);
  });
});
