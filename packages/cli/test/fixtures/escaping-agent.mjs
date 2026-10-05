// Test-only agent for run-isolation.test.ts. Pauses briefly (giving any detached
// grandchild left behind by the *previous* run a wide, predictable window to land a late
// request here, if this run's adversary/port were ever the previous run's reused one
// instead of its own fresh one), makes one ordinary request of its own (so the run's
// startup clock starts), spawns a detached grandchild that outlives it, then exits
// immediately without waiting for that grandchild - modelling a background worker or
// in-flight retry that survives past its own run's lifetime.
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

const baseUrl = process.env.X402_REDTEAM_BASE_URL;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function get(url) {
  return new Promise((resolvePromise) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on("end", resolvePromise);
    });
    req.on("error", resolvePromise);
  });
}

await sleep(250);
await get(`${baseUrl}/`);

const childScript = fileURLToPath(new URL("./escaping-agent-child.mjs", import.meta.url));
const child = spawn(process.execPath, [childScript, baseUrl], {
  detached: true,
  stdio: "ignore",
});
child.unref();

process.exit(0);
