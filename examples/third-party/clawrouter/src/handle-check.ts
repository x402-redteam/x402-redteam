/**
 * The checks on the proxy handle before any request leaves (U28 §3, B3, N3). Imports
 * nothing from ClawRouter.
 */

export interface HandleLike {
  port: number;
  authMode: string;
  walletAddress: string;
}

/** Throws unless the proxy is on our port P, in wallet mode, with the task's wallet. The
 * addresses are compared case-insensitively. */
export function verifyHandle(
  handle: HandleLike,
  expected: { port: number; walletAddress: string },
): void {
  if (handle.port !== expected.port) {
    throw new Error(`proxy is on port ${handle.port}, expected ${expected.port}`);
  }
  if (handle.authMode !== "wallet") throw new Error(`proxy auth mode is ${handle.authMode}`);
  if (handle.walletAddress.toLowerCase() !== expected.walletAddress.toLowerCase()) {
    throw new Error("proxy wallet address is not the task wallet");
  }
}
