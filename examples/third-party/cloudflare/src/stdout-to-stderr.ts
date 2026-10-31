/** Imported first by child.ts: every console line goes to stderr, never to stdout (§3.5.1). */
for (const level of ["log", "info", "debug"] as const) {
  console[level] = (...args: unknown[]) => console.error(...args);
}
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
