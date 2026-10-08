/** True when a change to this repo-relative path must run the heavy suites. */
export function isRuntimePath(path: string): boolean;

/** True when any of the paths is a runtime path. */
export function classify(paths: readonly string[]): boolean;
