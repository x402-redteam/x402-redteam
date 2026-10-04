import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Chain, HostModeSchema, type Severity } from "@x402-redteam/schema";
import { type Report, toMarkdown, toSarif } from "@x402-redteam/scorer";
import { Command } from "commander";
import { resolveAgentCommand } from "./guardrail-track.js";
import { runSuite } from "./run.js";
import { validateAgentUid } from "./spawn.js";
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
    "shell command that starts a GDP guardrail (ADR-010); runs the standard driver as the agent; mutually exclusive with --agent",
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
  .option("--season-seed-env <name>", "env var name holding the season's secret seed (ADR-011)")
  .option(
    "--guardrail-repo-ref <org/repo@sha>",
    "the guardrail-under-test's own repo@sha, recorded in config (security review HIGH-12)",
  )
  .option(
    "--agent-uid <n>",
    "run the agent as this uid (Linux, root only; never 0 or a reserved uid; ADR-011)",
  )
  .option("--agent-gid <n>", "run the agent as this gid (defaults to --agent-uid's value; ADR-011)")
  .option("--redact", "also write report.redacted.json (implies --quiet; ADR-011)")
  .option("--quiet", "print only exit code + summary numbers, never the full report (ADR-011)")
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

      // v3 (ADR-011, U19): --agent-uid is checked here, before runSuite ever spawns
      // anything, so an unsupported platform/privilege fails fast with exit 2 (same
      // "harness error / invalid run" exit code every other startup failure uses).
      let agentUid: number | undefined;
      if (opts.agentUid !== undefined) {
        agentUid = Number(opts.agentUid);
        if (!Number.isInteger(agentUid) || agentUid < 0) {
          throw new Error(`--agent-uid "${opts.agentUid}" is not a non-negative integer`);
        }
        const uidError = validateAgentUid(agentUid);
        if (uidError !== undefined) {
          throw new Error(uidError);
        }
      }
      // Security review LOW: --agent-gid defaults to --agent-uid's own value (a
      // dedicated, non-root, non-reserved gid matching the uid) rather than silently
      // inheriting the harness's own (root) gid.
      let agentGid: number | undefined;
      if (opts.agentGid !== undefined) {
        agentGid = Number(opts.agentGid);
        if (!Number.isInteger(agentGid) || agentGid < 0) {
          throw new Error(`--agent-gid "${opts.agentGid}" is not a non-negative integer`);
        }
      } else if (agentUid !== undefined) {
        agentGid = agentUid;
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
        seasonSeedEnv: opts.seasonSeedEnv,
        guardrailRepoRef: opts.guardrailRepoRef ?? null,
        agentUid,
        agentGid,
        redact: opts.redact === true,
        quiet: opts.quiet === true,
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
