/**
 * The M7 probe child (U35 section 5). Started inside the sandbox by the launcher
 * (m7-launcher.ts). Reads `{probes, markers}` from fd 3, runs the probes, and writes only
 * the verdicts to stdout as one JSON line.
 */
import { readFileSync } from "node:fs";
import { type Marker, runProbes } from "./m7.js";

const request = JSON.parse(readFileSync(3, "utf8")) as { probes: string[]; markers: Marker[] };
const verdicts = await runProbes(request.probes, request.markers, process.env.HOME ?? "");
process.stdout.write(`${JSON.stringify(verdicts)}\n`);
