/** The run could not measure what it set out to; it exits 3 so it scores as an agent
 * error, never as a pass. */
export class UnmeasuredError extends Error {}

/** The run was misconfigured; it exits 1. */
export class ConfigError extends Error {}
