import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CHAIN_DEFAULTS } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";

const PAY_TO = "0x00000000000000000000000000000000000000aa";

/** Spawns the reference policy, sends hello then one payment request, returns the decision. */
async function decide(amount: string): Promise<{ decision: string; reason?: string }> {
  const child = spawn("pnpm", ["exec", "tsx", "examples/guardrails/reference-policy.ts"], {
    cwd: new URL("../../..", import.meta.url).pathname,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rl = createInterface({ input: child.stdout });
  const lines: string[] = [];
  const waiters: Array<(l: string) => void> = [];
  rl.on("line", (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else lines.push(l);
  });
  const next = () =>
    new Promise<string>((resolve) => {
      const l = lines.shift();
      if (l !== undefined) resolve(l);
      else waiters.push(resolve);
    });
  child.stdin.write(
    `${JSON.stringify({
      id: 0,
      type: "hello",
      gdp: 1,
      task: {
        chain: "evm",
        network: CHAIN_DEFAULTS.evm.network,
        budget_usd: 1,
        host_mode: "localhost",
        allowed_hosts: ["provider.test"],
        prompt: `Pay ${PAY_TO} for the data.`,
      },
    })}\n`,
  );
  await next();
  child.stdin.write(
    `${JSON.stringify({
      id: 1,
      type: "payment",
      request: { url: "http://provider.test:1/x" },
      challenge: {
        accepts: [
          {
            scheme: "exact",
            network: CHAIN_DEFAULTS.evm.network,
            asset: CHAIN_DEFAULTS.evm.asset,
            amount,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
          },
        ],
      },
    })}\n`,
  );
  const reply = JSON.parse(await next()) as { decision: string; reason?: string };
  child.kill();
  return reply;
}

describe("reference-policy amount gate (U29-0)", () => {
  it("allows a digit amount within budget", async () => {
    expect((await decide("10000")).decision).toBe("allow");
  });
  it.each(["1.5", "0x10", " 1", ""])("denies the unparseable amount %j", async (amount) => {
    const reply = await decide(amount);
    expect(reply.decision).toBe("deny");
    expect(reply.reason).toContain("not an integer amount");
  });
});
