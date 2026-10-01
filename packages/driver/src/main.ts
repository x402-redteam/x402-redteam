/**
 * `driver@1` entry point, per functional-design.md §2/§3. Spawned by the harness exactly
 * like any agent under test (`packages/cli/src/guardrail-track.ts`'s
 * `resolveAgentCommand` for `--guardrail`), so it reads `task.json` from
 * `X402_REDTEAM_TASK` - the same env var every agent uses (application-design.md §6) -
 * rather than the functional-design draft's `X402_TASK_FILE` (reported as a deviation;
 * see this unit's report). `X402_GUARDRAIL_CMD` names the guardrail subprocess to spawn.
 *
 * Any behaviour change to this loop bumps the driver's own version tag past `driver@1`
 * (functional-design.md §3).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { CHAIN_DEFAULTS } from "@x402-redteam/schema";
import type { LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { allowedOrigins, type CrawlSeed, crawl, extractUrls } from "./crawl.js";
import { DEFAULT_HELLO_TIMEOUT_MS, GdpClient } from "./gdp.js";
import { extractTransferIntents, type TransferIntent } from "./intent.js";
import { buildPayFetch, type PayContext } from "./pay.js";
import type { GdpHook, GdpTransferResponse } from "./protocol.js";
import { sendDirectTransfer, type TransferContext } from "./transfer.js";

export const DRIVER_VERSION = "driver@1";

const MAX_TOP_LEVEL_ATTEMPTS = 4; // the initial fetch, plus up to 3 retries.
const MAX_DISCOVERY_FETCHES = 200;
const MAX_DEPTH = 4;

/** Code review finding 10: env var names never forwarded to the guardrail subprocess -
 * everything `X402_*` (including the driver's own task-file path and the harness's
 * facilitator URL) and anything ending in `_RPC_URL` (the mock EVM/Solana RPC
 * endpoints). A guardrail is meant to be a pure decision function over what the driver
 * tells it in GDP messages, not an independent actor with its own access to the task or
 * the chain - scrubbing these closes the easiest, most convenient path to that.
 *
 * Residual risk (documented, not eliminated): the guardrail runs as the *same* OS user
 * as the driver (Bolt 6 has no sandboxing between the two - ADR-011's `--agent-uid`
 * applies to the driver+guardrail pair together, as one unprivileged user, not to
 * separating them from each other). A sufficiently determined guardrail could still
 * locate `task.json` on disk (e.g. by scanning `/proc` or the harness's own `out/`
 * directory layout) or otherwise probe its surroundings; this scrub removes the
 * convenient, accidental leak, not every possible one.
 */
const GUARDRAIL_ENV_STRIP_RE = /^X402_|_RPC_URL$/i;

function scrubGuardrailEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (GUARDRAIL_ENV_STRIP_RE.test(key)) continue;
    if (value !== undefined) scrubbed[key] = value;
  }
  return scrubbed;
}

/** `task.json` (version 3, application-design.md "Contracts (v3, Bolt 6)"). Kept local
 * (rather than depending on `@x402-redteam/cli`) - the driver is self-contained,
 * functional-design.md §5. */
interface TaskFile {
  version: number;
  run_id: string;
  prompt: string;
  base_url: string;
  chain: "evm" | "svm";
  network: string;
  budget_usd: number;
  allowed_hosts: string[];
  wallet: { address: string; private_key: string } | { address: string; secret_key_base58: string };
  facilitator_url: string;
  solana_rpc_url: string;
  ledger_url: string;
  notice: string;
  wallet_balance_usd: number;
  evm_rpc_url: string;
  host_mode: string;
  hosts: Record<string, string>;
}

function readTask(): TaskFile {
  const path = process.env.X402_REDTEAM_TASK;
  if (!path) throw new Error("X402_REDTEAM_TASK is not set");
  return JSON.parse(readFileSync(path, "utf8")) as TaskFile;
}

function log(message: string): void {
  console.error(`[driver] ${message}`);
}

/** Code review finding 1: `hello`'s timeout is startup-scale, not the 5s hook timeout,
 * but must still fit inside the harness's own overall startup allowance
 * (`--startup-timeout`, default 120s) with room left for the driver's own boot - so it's
 * capped at `X402_STARTUP_TIMEOUT_S` seconds when the harness sets that (a future
 * wiring point; `run.ts` does not set it today), else `DEFAULT_HELLO_TIMEOUT_MS` (60s). */
function helloTimeoutMs(): number {
  const raw = process.env.X402_STARTUP_TIMEOUT_S;
  if (!raw) return DEFAULT_HELLO_TIMEOUT_MS;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_HELLO_TIMEOUT_MS;
}

async function shouldRetry(res: Response): Promise<boolean> {
  if (res.status === 402) return true;
  if (res.status === 200) {
    const body = await res
      .clone()
      .text()
      .catch(() => "x");
    return body.length === 0;
  }
  return false;
}

function withRetries(fetchFn: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    let res = await fetchFn(input, init);
    for (let attempt = 1; attempt < MAX_TOP_LEVEL_ATTEMPTS && (await shouldRetry(res)); attempt++) {
      res = await fetchFn(input, init);
    }
    return res;
  };
}

async function main(): Promise<void> {
  const task = readTask();
  const guardrailCmd = process.env.X402_GUARDRAIL_CMD;
  if (!guardrailCmd) throw new Error("X402_GUARDRAIL_CMD is not set");
  // Code review round 2: `proxy` mode needs the driver to honor HTTP_PROXY/http_proxy
  // (Node's global `fetch` ignores them - CLAUDE.md "Known SDK facts"; the documented
  // recipe is `undici`'s `EnvHttpProxyAgent`, not wired up here) and to render bare
  // origins rather than `task.hosts`'s absolute URLs. Rather than silently crawling
  // nothing (zero requests, a `path`-mode-shaped `allowedOrigins()` that matches
  // nothing proxy mode actually requests) or bypassing the proxy and leaking a real DNS
  // lookup, the driver refuses outright until this is implemented.
  if (task.host_mode === "proxy") {
    throw new Error(
      "driver@1 does not support host_mode 'proxy' yet - it would either crawl nothing or risk a real DNS lookup; refusing to run rather than producing a misleading report",
    );
  }

  const taskPath = process.env.X402_REDTEAM_TASK as string;
  const runsDir = resolve(dirname(taskPath), "..", "runs");
  mkdirSync(runsDir, { recursive: true });

  const evmAccount: LocalAccount | undefined =
    task.chain === "evm"
      ? privateKeyToAccount((task.wallet as { private_key: string }).private_key as `0x${string}`)
      : undefined;
  const svmSigner =
    task.chain === "svm"
      ? await createKeyPairSignerFromBytes(
          getBase58Encoder().encode(
            (task.wallet as { secret_key_base58: string }).secret_key_base58,
          ),
        )
      : undefined;

  const gdp = new GdpClient(guardrailCmd, scrubGuardrailEnv(process.env), log);
  try {
    // Code review finding 1 (BLOCK): a `hello` failure (timeout, crash, invalid/empty
    // hooks) throws - `GdpClient.hello` never falls back to "no hooks", because that is
    // behaviourally identical to `allow-all` and would silently mis-score a broken
    // guardrail as a deliberately permissive one. Letting this propagate out of `main()`
    // (caught by the top-level `.catch` below, which sets a non-zero exit code) is the
    // only correct outcome: the run becomes `error`, not a misleadingly valid pass.
    const hello = await gdp.hello(
      {
        prompt: task.prompt,
        chain: task.chain,
        network: task.network,
        budget_usd: task.budget_usd,
        allowed_hosts: task.allowed_hosts,
        wallet_address: task.wallet.address,
        wallet_balance_usd: task.wallet_balance_usd,
        host_mode: task.host_mode,
      },
      helloTimeoutMs(),
    );
    const hooks = new Set<GdpHook>(hello.hooks);

    // Code review round 2 (mirrors examples/agents/src/lib/crawl.ts's `allowedOrigins`):
    // exact-origin-set membership, never a prefix/suffix match - see crawl.ts's
    // docstring for why `http://a.localhost.evil.com` must never be treated as crawlable
    // just because it starts with an allowed `*.localhost` string.
    const origins = allowedOrigins(task);

    const payCtx: PayContext = {
      gdp,
      hooks,
      history: [],
      wallet: {
        chain: task.chain,
        evmAccount,
        svmSigner,
        solanaRpcUrl: task.solana_rpc_url,
      },
      log,
      challengeTexts: [],
    };

    // Every (url, text) pair the driver has seen, so a GDP `payment`/`transfer`
    // request's `referrer`/`source` can cite where the instruction came from. A seed
    // (a URL named directly in the task prompt, not discovered via a page) cites the
    // empty string as its "page URL" and the task prompt itself as its text - there is
    // no page it was found on, only the prompt - matching the reference agents'
    // convention of treating the prompt as the depth-0 "referrer".
    const sourceByUrl = new Map<string, { url: string; text: string }>();
    const TASK_PROMPT_AS_SOURCE_URL = "";

    // Code review finding 7: `crawl()` itself now fetches every seed (and every
    // discovered link) twice, so seeds are passed once each here.
    const seedUrls = extractUrls(task.prompt, origins);
    const seeds: CrawlSeed[] = seedUrls.map((url) => ({
      url,
      referrerUrl: TASK_PROMPT_AS_SOURCE_URL,
      referrerBody: task.prompt,
    }));

    const payFetch = buildPayFetch(payCtx, (url) => sourceByUrl.get(url) ?? null);
    const fetchWithRetries = withRetries(payFetch);

    const pages = await crawl(fetchWithRetries, seeds, {
      origins,
      maxDepth: MAX_DEPTH,
      maxFetches: MAX_DISCOVERY_FETCHES,
      onDiscover: (url, referrerUrl, referrerBody) => {
        if (!sourceByUrl.has(url)) {
          sourceByUrl.set(url, { url: referrerUrl, text: referrerBody });
        }
      },
    });

    // functional-design.md §3 step 5: every fetched page body, plus every 402
    // body/error text the driver saw along the way (even one later superseded by a
    // successful paid delivery, e.g. challenge_injection's prose riding along in the
    // 402 JSON).
    const intentSources: { url: string; text: string }[] = [
      ...pages.map((p) => ({ url: p.url, text: p.body })),
      ...payCtx.challengeTexts,
    ];

    const transferCtx: TransferContext = {
      gdp,
      hooks,
      wallet: { evmAccount, svmSigner },
      evmRpcUrl: task.evm_rpc_url,
      solanaRpcUrl: task.solana_rpc_url,
      network: task.network,
      log,
    };

    const seenIntents = new Set<string>();
    for (const source of intentSources) {
      const intents: TransferIntent[] = extractTransferIntents(source.text);
      for (const intent of intents) {
        if (intent.chain !== task.chain) continue; // no wallet for the other chain this run.
        const key = `${source.url}\u0000${intent.to}\u0000${intent.amount_usd}`;
        if (seenIntents.has(key)) continue;
        seenIntents.add(key);

        if (hooks.has("transfer")) {
          const decision = await gdp.request<GdpTransferResponse>((id) => ({
            id,
            type: "transfer",
            intent: {
              to: intent.to,
              amount_usd: intent.amount_usd,
              asset: CHAIN_DEFAULTS[intent.chain].asset,
              chain: intent.chain,
            },
            source,
          }));
          // GdpClient already normalizes any non-conforming response to a clean deny.
          if (decision.decision !== "allow") {
            log(
              `transfer denied for ${intent.to}: ${"reason" in decision ? decision.reason : "denied"}`,
            );
            continue;
          }
        }

        try {
          await sendDirectTransfer(transferCtx, intent);
        } catch (err) {
          log(`sendDirectTransfer failed for ${intent.to}: ${err}`);
        }
      }
    }

    // Code review finding 4 (BLOCK): written once, at the very end of a successful run,
    // so `guardrail_errors` reflects the *whole* session (hello plus every payment/
    // transfer/sign round trip), not just whatever had happened by the time `hello`
    // returned. `run.ts` deletes any stale copy of this file before spawning the
    // driver (finding 5) and requires a fresh one to exist when this run exits 0.
    writeFileSync(
      resolve(runsDir, `${task.run_id}.gdp.json`),
      `${JSON.stringify(
        {
          hooks: hello.hooks,
          name: hello.name,
          version: hello.version,
          nondeterministic: hello.nondeterministic,
          guardrail_errors: gdp.errorCount,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    gdp.close();
  }
}

// Only run when this file is the process entry point (via the `x402-redteam-driver`
// bin/tsx), not when `index.ts` re-exports `DRIVER_VERSION` for tests/callers.
// `pathToFileURL` (rather than hand-building a `file://` string) handles paths with
// spaces or other characters that need percent-encoding, and is correct on Windows too.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
