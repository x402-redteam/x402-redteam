import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Chain, HostModeSchema, type Severity } from "@x402-redteam/schema";
import { type Report, toMarkdown, toSarif } from "@x402-redteam/scorer";
import { Command } from "commander";
import { resolveAgentCommand } from "./guardrail-track.js";
import { runSuite } from "./run.js";
import { validate } from "./validate.js";

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const program = new Command();
program.name("x402-redteam").description("x402 red-team harness");

program
  .command("run")
  .option("--agent <cmd>", "shell command that starts the agent under test")
  .option(
    "--guardrail <cmd>",
    "shell command that starts a GDP guardrail (ADR-010; not yet implemented, see U18); mutually exclusive with --agent",
  )
  .option("--corpus <dir>", "corpus directory", "./corpus")
  .option("--chains <list>", "comma-separated chains (evm,svm)", "evm,svm")
  .option("--scenario <ids>", "comma-separated scenario ids to run (default: all)")
  .option("--repeat <n>", "attempts per scenario x chain", "1")
  .option(
    "--timeout <seconds>",
    "per-run timeout in seconds, counted from the agent's first request",
    "60",
  )
  .option(
    "--startup-timeout <seconds>",
    "how long an agent may take to make its first request before the run is killed",
    "120",
  )
  .option("--seed <seed>", "deterministic seed", "x402-redteam-v1")
  .option("--out <dir>", "output directory", "./out")
  .option("--agent-id <name>", "agent id recorded in the report", "agent")
  .option("--guardrail-id <name>", "guardrail id recorded in the report", "none")
  .option(
    "--fail-on <severity>",
    "minimum severity that fails the run (low|medium|high|critical)",
    "low",
  )
  .option("--pass-env <names>", "comma-separated extra env var names to pass through to the agent")
  .option(
    "--skip-controls",
    "skip control scenarios (debug only; invalidates the report per ADR-009)",
  )
  .option(
    "--host-mode <mode>",
    "how virtual hosts are rendered: localhost|path|proxy (ADR-012)",
    "localhost",
  )
  .option(
    "--season-seed-env <name>",
    "env var name holding the season's secret seed (ADR-011; not yet implemented, see U19)",
  )
  .option(
    "--agent-uid <n>",
    "run the agent as this uid (Linux, root only; not yet implemented, see U19)",
  )
  .option("--redact", "also write report.redacted.json (ADR-011; not yet implemented, see U19)")
  .action(async (opts) => {
    try {
      if (opts.agent !== undefined && opts.guardrail !== undefined) {
        throw new Error("--agent and --guardrail are mutually exclusive");
      }
      const resolved = resolveAgentCommand({ agent: opts.agent, guardrail: opts.guardrail });

      const hostModeResult = HostModeSchema.safeParse(opts.hostMode);
      if (!hostModeResult.success) {
        throw new Error(
          `--host-mode "${opts.hostMode}" is invalid (expected localhost|path|proxy)`,
        );
      }
      if (opts.agentUid !== undefined) {
        throw new Error("--agent-uid is not implemented yet (owner U19)");
      }
      if (opts.redact === true) {
        throw new Error("--redact is not implemented yet (ADR-011, owner U19)");
      }
      if (opts.seasonSeedEnv !== undefined) {
        throw new Error("--season-seed-env is not implemented yet (ADR-011, owner U19)");
      }

      const { exitCode } = await runSuite({
        ...resolved,
        corpus: resolve(opts.corpus),
        chains: splitList(opts.chains) as Chain[],
        scenarioIds: opts.scenario ? splitList(opts.scenario) : undefined,
        repeat: Number(opts.repeat),
        timeoutMs: Number(opts.timeout) * 1000,
        startupTimeoutMs: Number(opts.startupTimeout) * 1000,
        seed: opts.seed,
        outDir: resolve(opts.out),
        agentId: opts.agentId,
        guardrailId: opts.guardrailId,
        failOn: opts.failOn as Severity,
        passEnv: splitList(opts.passEnv),
        skipControls: opts.skipControls === true,
        hostMode: hostModeResult.data,
      });
      process.exit(exitCode);
    } catch (err) {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(2);
    }
  });

program
  .command("validate")
  .option("--corpus <dir>", "corpus directory", "./corpus")
  .action((opts) => {
    try {
      process.exit(validate(resolve(opts.corpus)));
    } catch (err) {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(2);
    }
  });

program
  .command("report")
  .requiredOption("--in <file>", "path to a report.json")
  .requiredOption("--format <fmt>", "md|sarif")
  .action((opts) => {
    try {
      const report = JSON.parse(readFileSync(resolve(opts.in), "utf8")) as Report;
      if (opts.format === "md") {
        process.stdout.write(toMarkdown(report));
      } else if (opts.format === "sarif") {
        process.stdout.write(toSarif(report));
      } else {
        console.error(`report: unknown --format "${opts.format}" (expected md|sarif)`);
        process.exit(2);
      }
    } catch (err) {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(2);
    }
  });

await program.parseAsync(process.argv);
