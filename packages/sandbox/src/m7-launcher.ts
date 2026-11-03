/**
 * The M7 launcher (U35 section 5). Run unsandboxed with `X402_M7_SECRET` (a random marker)
 * in its *exec* environment, and optionally `X402_ANTHROPIC_KEY_FILE`. It starts the probe
 * child through the shared spawn, hands it the markers over fd 3 (never the environment, so
 * the child's own process holds no marker), and prints the child's verdicts as one JSON line.
 * Argument 2 is JSON: `{label, loader, guardEntry?, probes, taskPath?, extraEnvFromParent?}`.
 */
import { readKeyFile } from "./keyfile.js";
import type { Marker } from "./m7.js";
import { spawnSandboxed } from "./spawn.js";
import { TEST_ONLY } from "./testing.js";

const opts = JSON.parse(process.argv[2] ?? "{}") as {
  label: string;
  loader: string;
  guardEntry?: string;
  probes: string[];
  sandbox?: boolean;
};

const markers: Marker[] = [];
if (process.env.X402_M7_SECRET) markers.push({ id: "env", value: process.env.X402_M7_SECRET });
// Key-file mode: read into memory, never into process.env (M5).
const keyFile = process.env.X402_ANTHROPIC_KEY_FILE;
if (keyFile) markers.push({ id: "key", value: readKeyFile(keyFile) });

const child = spawnSandboxed({
  label: opts.label,
  script: new URL("./m7-child.ts", import.meta.url).pathname,
  loader: opts.loader,
  guardEntry: opts.guardEntry ?? "",
  guard: false,
  sandbox: opts.sandbox ?? true,
  [TEST_ONLY]: { skipPreflight: true },
  stdio: ["ignore", "pipe", "inherit", "pipe"],
});
let out = "";
child.proc.stdout?.on("data", (d) => {
  out += d;
});
const channel = child.proc.stdio[3];
if (channel && "end" in channel) {
  (channel as import("node:stream").Writable).end(JSON.stringify({ probes: opts.probes, markers }));
}
const code = await new Promise<number | null>((resolve) => child.proc.on("close", resolve));
child.dispose();
process.stdout.write(out.trim().split("\n").pop() ?? "[]");
process.stdout.write("\n");
process.exit(code === 0 ? 0 : 1);
