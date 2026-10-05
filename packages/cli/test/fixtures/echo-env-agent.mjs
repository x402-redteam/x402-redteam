// Test-only agent for harness-commit.test.ts's env-forwarding check: prints every env
// var name it can see, as a single JSON line, and exits.
process.stdout.write(`${JSON.stringify(Object.keys(process.env))}\n`);
