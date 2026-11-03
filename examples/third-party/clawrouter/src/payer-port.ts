/**
 * The payer's default port and the variable that carries the child's own proxy port P
 * (U28 sections 3 and 6, N1). The port allowlist itself is built by @x402-redteam/sandbox
 * from the harness port, P, and the refused port below; this file holds only what is specific
 * to this adapter.
 */
import { parsePort } from "@x402-redteam/sandbox";

/** The payer's default port. The child may never reach it, and the parent refuses to start
 * while anything listens on it. */
export const DEFAULT_PAYER_PORT = 8402;

/** The environment variable that carries P to the child and the guard. */
export const PORT_ENV = "X402_CLAWROUTER_PORT";

/** Parses P; undefined unless it is a valid port other than the payer's default. */
export function parseProxyPort(value: string | undefined): number | undefined {
  const port = parsePort(value);
  return port !== undefined && port !== DEFAULT_PAYER_PORT ? port : undefined;
}
