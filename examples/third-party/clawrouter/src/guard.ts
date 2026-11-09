/**
 * Egress guard entry for the ClawRouter child (U25 section 3.1 layer 2, U28 section 6,
 * ADR-029, U35). Preloaded with `node --import <tsx> --import ./guard.ts`, before any
 * third-party code. The implementation is shared; this file is configuration only.
 *
 * Only loopback, `*.localhost` and the hosts the task declares pass, and only on the two
 * allowed ports: the harness's (from the task's base_url) and the child's own proxy port P
 * (X402_CLAWROUTER_PORT). The payer's default port is refused. The package's npm update check
 * gets a local 204 at the fetch layer.
 */
import { installGuard } from "@x402-redteam/sandbox/guard";
import { DEFAULT_PAYER_PORT, PORT_ENV } from "./payer-port.js";

/** The only request that leaves the process and is answered locally (a 204): the
 * package's npm update check. Its reply is never used. */
export const UPDATE_CHECK_URL = "https://registry.npmjs.org/@blockrun/clawrouter/latest";

const guard = installGuard({
  label: "clawrouter",
  portEnv: PORT_ENV,
  refusedPorts: [DEFAULT_PAYER_PORT],
  stubs: [{ url: UPDATE_CHECK_URL, match: "path" }],
});

/** The allowed ports, for the canary. */
export const guardAllowedPorts = (): number[] => guard.allowedPorts();
