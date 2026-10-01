# U22 — Action v3, exact-exit self-test, and the real-runner verification plan · Functional Design

Author: senior-architect · Implementer: Sonnet (the file work) plus the **orchestrator** (the real-runner run, after the user creates the repo) · Bolt 6 **Phase C**
Contract: Review 1 M7, bolt5-closeout N2, ADR-010/011/012

## 1. Goal
The Action exposes the v3 surface, and self-test asserts *exact* exit codes. Everything that only a real GitHub runner can prove is listed as a checklist with the evidence to capture. Nothing is called "verified" until that evidence exists in `audit.md`.

## 2. Files (owned in Phase C)
```
action.yml                     inputs: guardrail (mutually exclusive with agent), host-mode (default localhost), redact; outputs: exit-code, valid,
                               safety-score, reach-rate; all inputs via env: (keep U12's injection fix); document permissions
                               (security-events: write for SARIF; id-token/attestations: write only for rank.yml)
.github/workflows/self-test.yml  matrix of {cmd, expected exit}: naive→1, guarded→0, "true"→2, guardrail allow-all→1, guardrail deny-all→2,
                               reference-policy→0; assert steps.run.outputs.exit-code == expected (not `outcome`)
.github/workflows/ci.yml       add a job "host-resolution": `getent hosts x402rt-probe.localhost` + node dns.lookup + python getaddrinfo (records evidence);
                               e2e job timeout stays 60 min; split E2E into matrix shards by file to stay under it
README.md                      Action usage section only (guardrail-track example, permissions)
aidlc-docs/construction/U22-action-launch-ci/real-runner-checklist.md   NEW (developer writes the checklist; the orchestrator fills the evidence)
```

## 3. Real-runner checklist (the orchestrator runs it after the user decision "create repo and push")
1. `ci.yml`: lint, typecheck and unit tests are green. Record the durations.
2. The `host-resolution` job proves `*.localhost` resolves on `ubuntu-latest` (Node and Python). **If it fails:** canonical `host_mode` cannot be `localhost` on runners. Stop, and escalate to the architect: the fallback is ADR-012 proxy mode, or an `/etc/hosts` step in the Action.
3. e2e shards are green, with per-shard durations recorded. Each must be under 60 min, or re-shard.
4. self-test matrix: all six exact exit codes.
5. SARIF upload works with only `security-events: write`. Capture a screenshot or the API response from code scanning.
6. `rank.yml` (called from a throwaway public test repo running `examples/guardrails/reference-policy.ts`) produces an attestation, and `gh attestation verify --signer-workflow` succeeds. A tampered `report.json` must fail verification.
7. `ranked-run.yml` dry run with a **dummy** season (test seed and a 3-scenario dummy held-out corpus):
   - the container has no network (`curl` fails inside it);
   - the agent uid cannot read the corpus;
   - the seed is absent from all logs and artifacts;
   - only the redacted report and the attestation are uploaded.
8. The Python agent works on the runner in localhost mode (EVM).

## 4. Acceptance tests
**Developer (each < 1 min):**
- `action.yml` and the workflows parse as YAML (node `yaml` script in a unit test);
- a unit test asserts every `inputs.*` reference in `action.yml` appears only inside `env:`. This is a regex test that prevents the M7 regression.

**Orchestrator:** the checklist, with the evidence pasted into `audit.md`.

## 5. Do not
- Push, create repos or environments, or set secrets. Those are user decisions; the orchestrator acts only after explicit approval.
- Install actionlint, act or docker locally.
- Change harness behaviour.
- Commit, except the single worktree commit.
