export type ResolveImageResult =
  | { ok: true; digest: string; commit: string; version: string; error?: undefined }
  | { ok: false; error: string };

/** Looks up a vX.Y.Z tag or 40-hex commit in a parsed results/_harness.json. */
export function resolveImage(harnessJson: unknown, ref: unknown): ResolveImageResult;

/** Runs the CLI against an environment map without exiting. */
export function main(env: Record<string, string | undefined>): {
  status: number;
  stdout: string;
  stderr: string;
};
