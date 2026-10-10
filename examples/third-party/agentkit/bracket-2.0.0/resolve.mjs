// Bracket install (U25 §3.3, §3.5.4): runs the adapter's own ../src against this
// directory's node_modules (@x402/* 2.0.0) instead of ../node_modules (2.28.0).
// Preload it before tsx: node --import ./bracket-2.0.0/resolve.mjs --import tsx ...
// sandbox.ts forwards it to the AgentKit child.
import { register } from "node:module";

register("./resolve-hooks.mjs", import.meta.url);
globalThis.__x402AgentkitDepsHook = import.meta.url;
