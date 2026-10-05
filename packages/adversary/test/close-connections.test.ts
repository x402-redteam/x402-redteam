import net from "node:net";
import { describe, expect, it } from "vitest";
import { createAdversary } from "../src/index.js";
import { buildFixtureScenario } from "./fixtures/scenario.js";
import { makeCapture } from "./stub-capture.js";

/**
 * `close()` must resolve promptly even while a client is holding a busy keep-alive
 * connection open - not wait for that connection to end on its own, which a client still
 * mid-request never does by itself. Modelled here as a raw socket that opens a
 * keep-alive connection and sends a request with its final header terminator withheld,
 * so the server is left genuinely waiting on it (not merely idle between requests,
 * which `server.close()` already handles on its own) - deterministic, unlike timing a
 * close against a request loop and hoping it lands mid-flight.
 */
describe("Adversary.close() with a busy keep-alive client", () => {
  it("resolves in well under a second while a client's request on a keep-alive socket is still in flight", async () => {
    const adversary = await createAdversary({ seed: "x402-redteam-v1", capture: makeCapture() });
    adversary.load({ scenario: buildFixtureScenario(), chain: "evm", run_id: "close-keepalive" });

    const url = new URL(adversary.baseUrl);
    const socket = net.connect(Number(url.port), url.hostname);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    // Deliberately never sends the blank line that ends the headers - the server is
    // left actively waiting on this request, not idle.
    socket.write(`GET /free HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const start = performance.now();
    await adversary.close();
    const elapsedMs = performance.now() - start;

    socket.destroy();
    expect(elapsedMs).toBeLessThan(1000);
  });
});
