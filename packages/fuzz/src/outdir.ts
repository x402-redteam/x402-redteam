import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** The path with its deepest existing ancestor resolved through symlinks. */
function canonical(path: string): string {
  const abs = resolve(path);
  const rest: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    rest.unshift(cur.slice(dirname(cur).length + 1));
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return join(realpathSync(cur), ...rest);
}

/** The nearest ancestor directory holding `.git` (a directory, or a file in a worktree). */
function repoRootOf(path: string): string | null {
  let cur = path;
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * `--out` must not write fuzz output into a git working tree (ADR-028 #7), unless the path
 * sits under a directory ending in `.fuzz` or named `fuzz-out`, which `.gitignore` and
 * scripts/fuzz-guard.mjs both cover. Outside any repository it is always fine. Throws.
 */
export function assertOutDirAllowed(outDir: string): void {
  const target = canonical(outDir);
  const root = repoRootOf(target);
  if (root === null) return;
  const segments = relative(root, target).split(sep).filter(Boolean);
  if (segments.some((s) => s === "fuzz-out" || s.endsWith(".fuzz"))) return;
  throw new Error(
    `--out ${outDir} is inside a git repository (${root}). Fuzz output stays private ` +
      "(ADR-028 #7): write outside the repository, or to a directory ending in .fuzz or named fuzz-out.",
  );
}
