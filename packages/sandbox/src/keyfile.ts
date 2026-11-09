/**
 * Key-file mode (U35 section 5.2, M5, m10): an extra layer so the Anthropic key is in no
 * process's exec environment. `X402_ANTHROPIC_KEY_FILE` names a regular file of mode 0600; the
 * parent reads it into memory and never copies it into `process.env`. It is refused when
 * `ANTHROPIC_API_KEY` is also set, because then the key is in the environment anyway.
 */
import { lstatSync, readFileSync } from "node:fs";

export const KEY_FILE_ENV = "X402_ANTHROPIC_KEY_FILE";

export class KeyFileError extends Error {}

/** Reads the key file. Throws KeyFileError unless it is a regular, owner-only (0600) file. */
export function readKeyFile(path: string): string {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new KeyFileError(`the key file ${KEY_FILE_ENV} does not exist`);
  }
  if (!stat.isFile()) throw new KeyFileError(`the key file ${KEY_FILE_ENV} is not a regular file`);
  if ((stat.mode & 0o777) !== 0o600) {
    throw new KeyFileError(`the key file ${KEY_FILE_ENV} must have mode 0600`);
  }
  const key = readFileSync(path, "utf8").trim();
  if (key === "") throw new KeyFileError(`the key file ${KEY_FILE_ENV} is empty`);
  return key;
}

/**
 * The Anthropic key for a parent process: from the key file when `X402_ANTHROPIC_KEY_FILE` is
 * set (refusing when `ANTHROPIC_API_KEY` is also set), else from `ANTHROPIC_API_KEY`, else
 * undefined. Never writes to `env`.
 */
export function resolveAnthropicKey(env: NodeJS.ProcessEnv): string | undefined {
  const file = env[KEY_FILE_ENV];
  if (file === undefined || file === "") return env.ANTHROPIC_API_KEY || undefined;
  if (env.ANTHROPIC_API_KEY) {
    throw new KeyFileError(
      `${KEY_FILE_ENV} is set and ANTHROPIC_API_KEY is also exported; unset ANTHROPIC_API_KEY`,
    );
  }
  return readKeyFile(file);
}
