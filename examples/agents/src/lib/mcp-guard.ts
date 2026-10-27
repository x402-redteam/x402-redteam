/**
 * The `mcp-guarded` agent's spend policy (U30-2), split out so it can be tested without
 * running the agent. The running total is checked in the `policies` filter, before the SDK
 * signs, and charged only after a payload was created (`x402Client.onAfterPaymentCreation`,
 * @x402/core 2.28.0 client/index.mjs:198, run at :309-318 once the payload exists). A
 * creation that throws after the offer was selected therefore costs nothing.
 */
import type { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { CHAIN_DEFAULTS, namedRecipients, recipientAllowed } from "@x402-redteam/schema";
import { challengeAmountUsd } from "./amount-check.js";
import { parseHostPath } from "./host-check.js";
import { advertisedToolPrice, approvedPrices } from "./mcp.js";
import type { TaskFile } from "./wallet.js";

export const BUDGET_EPSILON = 1e-9;
const PRICE_TOLERANCE = 1.01;
const MAX_TIMEOUT_SECONDS = 900;

export interface McpGuard {
  /** The `policies` filter: only offers that pass every check reach the SDK's selector. */
  policy: (version: number, requirements: PaymentRequirements[]) => PaymentRequirements[];
  onPaymentRequested: (ctx: { paymentRequired: { accepts: PaymentRequirements[] } }) => boolean;
  /** Registers the after-creation hook that charges the running total. */
  attach: (payments: Pick<x402Client, "onAfterPaymentCreation">) => void;
  /** The server and tool the next payment is for. */
  target: (server: string, tool?: string) => void;
  describe: (tool: string, description: string | undefined) => void;
  spentUsd: () => number;
  remainingUsd: () => number;
}

export function createMcpGuard(task: TaskFile): McpGuard {
  const defaults = CHAIN_DEFAULTS.evm;
  const allowedHosts = new Set(task.allowed_hosts);
  const named = namedRecipients(task.prompt, task.chain);
  const approved = approvedPrices(task.prompt);
  const descriptions = new Map<string, string | undefined>();
  let spentUsd = 0;
  let currentServer = "";
  let currentTool = "";

  /** Whether the SDK may sign this offer for the tool now being called. */
  const passes = (req: PaymentRequirements): boolean => {
    if (!allowedHosts.has(parseHostPath(currentServer, task).host)) return false;
    if (req.network !== task.network) return false;
    if (!recipientAllowed(named, req.payTo, task.chain)) return false;
    if (req.maxTimeoutSeconds > MAX_TIMEOUT_SECONDS) return false;
    if (req.asset.toLowerCase() !== defaults.asset.toLowerCase()) return false;
    const checked = challengeAmountUsd(req.amount, defaults.decimals);
    if ("deny" in checked) return false;
    const usd = checked.usd;
    if (usd > task.budget_usd + BUDGET_EPSILON) return false;
    if (spentUsd + usd > task.budget_usd + BUDGET_EPSILON) return false;
    const bound = approved.get(currentTool);
    if (bound !== undefined) return usd <= bound + BUDGET_EPSILON;
    const advertised = advertisedToolPrice(descriptions.get(currentTool));
    return advertised === undefined || usd <= advertised * PRICE_TOLERANCE;
  };

  return {
    policy: (_v, requirements) => requirements.filter(passes),
    onPaymentRequested: ({ paymentRequired }) => paymentRequired.accepts.some(passes),
    attach: (payments) => {
      payments.onAfterPaymentCreation(async ({ selectedRequirements }) => {
        const checked = challengeAmountUsd(selectedRequirements.amount, defaults.decimals);
        if ("usd" in checked) spentUsd += checked.usd;
      });
    },
    target: (server, tool = "") => {
      currentServer = server;
      currentTool = tool;
    },
    describe: (tool, description) => {
      descriptions.set(tool, description);
    },
    spentUsd: () => spentUsd,
    remainingUsd: () => task.budget_usd - spentUsd,
  };
}
