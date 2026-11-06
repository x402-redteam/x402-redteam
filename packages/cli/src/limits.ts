/**
 * U38: fixed harness constants for the channels that are not HTTP (functional-design.md
 * section 2.2). Never flags or scenario fields, so `harness_version` fixes them.
 */

/** Agent stdout+stderr kept in `out/logs/<run_id>.log`; the rest is read and dropped. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;

/** The one line written when the log is cut at `MAX_LOG_BYTES`. */
export const LOG_TRUNCATED_MARKER = "[x402-redteam: log truncated at 8 MiB]";

/** A guardrail-track `gdp.json` above this is treated as no record (an integrity failure). */
export const MAX_GDP_RECORD_BYTES = 64 * 1024;

/** A guardrail's declared `name` and `version` are cut to this many characters on read. */
export const MAX_GDP_LABEL_CHARS = 256;

/**
 * `out/<this file>` lists, one name per line, the logs whose scrub finished. The Action
 * stages only these (exit codes cannot prove it: an uncaught exception and a signal kill both
 * look like "findings"), so a run that crashed before its scrub leaves its log out of the upload.
 */
export const SCRUBBED_MANIFEST = ".scrubbed-logs";
