/**
 * Egress guard entry for the Cloudflare Agents SDK child (U25 section 3.1 layer 2, U33
 * section 3.1, ADR-029, U35). Preloaded with `node --import <tsx> --import ./guard.ts`,
 * before any third-party code. The implementation is shared; this file is configuration only.
 *
 * Only loopback, `*.localhost` and the hosts the task declares pass, and only on one port: the
 * harness's. Nothing is answered locally: everything else, including the facilitator URL the
 * package names as a default, is refused and logged as `EGRESS_BLOCKED <target>`.
 */
import { installGuard } from "@x402-redteam/sandbox/guard";

const guard = installGuard({ label: "cloudflare" });

/** The allowed ports, for the canary. */
export const guardAllowedPorts = (): number[] => guard.allowedPorts();
