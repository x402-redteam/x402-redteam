import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../src/index.js";
import { makeCapture } from "./stub-capture.js";

const SEED = "x402-redteam-v1";

/** Binds a throwaway raw server on `::1` at an OS-chosen ephemeral port, so the test can
 * then ask `createAdversary` for that *exact* port (via `port:`) and know its `::1` side
 * is genuinely occupied by something unrelated - a real reproduction of code review F5's
 * "never silently share" scenario, not a mock. */
function occupyIpv6Port(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => res.end("occupied"));
    server.on("error", reject);
    server.listen(0, "::1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      if (port === undefined) {
        reject(new Error("occupant server has no port"));
        return;
      }
      resolve({ server, port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("dual-stack binding (ADR-012 full §2, code review F5)", () => {
  let adversary: Adversary | undefined;
  let occupant: Server | undefined;

  afterEach(async () => {
    if (adversary) await adversary.close();
    if (occupant) await closeServer(occupant);
    adversary = undefined;
    occupant = undefined;
  });

  it("binds both 127.0.0.1 and ::1 on the same ephemeral port by default", async () => {
    adversary = await createAdversary({ seed: SEED, capture: makeCapture() });
    const port = new URL(adversary.baseUrl).port;

    // Both addresses actually answer on the same port number.
    const v4 = await fetch(`http://127.0.0.1:${port}/__harness/health`);
    expect(v4.status).toBe(200);
    const v6 = await fetch(`http://[::1]:${port}/__harness/health`);
    expect(v6.status).toBe(200);
  });

  it("never silently shares an explicitly-requested port whose ::1 side is already taken by another process", async () => {
    const occupied = await occupyIpv6Port();
    occupant = occupied.server;

    await expect(
      createAdversary({ seed: SEED, capture: makeCapture(), port: occupied.port }),
    ).rejects.toThrow(/already in use on ::1/);
  });

  it("still binds an explicitly-requested port when its ::1 side is genuinely free", async () => {
    // Grab a real free port by briefly binding, then releasing, an IPv4 ephemeral socket.
    const probe = await new Promise<{ server: Server; port: number }>((resolve, reject) => {
      const server = createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : undefined;
        if (port === undefined) {
          reject(new Error("probe server has no port"));
          return;
        }
        resolve({ server, port });
      });
    });
    await closeServer(probe.server);

    adversary = await createAdversary({ seed: SEED, capture: makeCapture(), port: probe.port });
    expect(new URL(adversary.baseUrl).port).toBe(String(probe.port));
  });
});
