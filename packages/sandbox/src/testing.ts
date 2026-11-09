/**
 * Test-only switches for spawnSandboxed (U35 D1). They live behind a plain (unregistered) symbol key that
 * is not exported from the package index and cannot be rebuilt with `Symbol.for`, and a policy test fails if any adapter `src` file refers to
 * it. Only the conformance canary, the M7 launcher and the adapters' canary tests use it.
 */
export const TEST_ONLY: unique symbol = Symbol("x402-redteam.sandbox.test-only") as never;

export interface TestOnly {
  /** Skip the runtime preflight (the layers themselves are what is under test). */
  skipPreflight?: boolean;
  /** Deny reads under this root instead of the parent's real home (C4(a)). */
  deniedRoot?: string;
}
