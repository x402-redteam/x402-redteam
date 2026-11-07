/** A stand-in for an adapter parent in key-file mode: reads the key into memory, never into
 * process.env, signals readiness on stdout and waits to be killed. */
import { resolveAnthropicKey } from "../src/keyfile.js";

const key = resolveAnthropicKey(process.env);
process.stdout.write(`ready ${key ? key.length : 0}\n`);
setInterval(() => {}, 1000);
