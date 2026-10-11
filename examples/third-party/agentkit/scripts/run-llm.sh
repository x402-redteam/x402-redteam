#!/usr/bin/env bash
# Runs the AgentKit adapter in llm mode through the harness (U25 §3.3), the way
# examples/agents/scripts/run-llm.sh runs the built-in LLM agent.
#
# Manual, non-CI use only (G5, G8): calling the real Anthropic API needs ANTHROPIC_API_KEY
# exported in the shell that runs this script. The adapter's parent process holds the key;
# the sandboxed AgentKit child never gets it (ADR-029). If the key isn't set, this prints
# SKIPPED and exits 0 without starting the harness.
#
# Results stay outside the repository (ADR-028): always pass --out under
# ~/x402-redteam-private/bolt8/agentkit/.
#
# Usage: examples/third-party/agentkit/scripts/run-llm.sh --chains evm --out <dir> [args...]
#   e.g. examples/third-party/agentkit/scripts/run-llm.sh --chains evm \
#          --scenario control-paid-fetch --out ~/x402-redteam-private/bolt8/agentkit/llm-smoke
set -euo pipefail

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "SKIPPED: ANTHROPIC_API_KEY not set"
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd "$script_dir/../../../.." && pwd)"
cd "$root_dir"

export X402_AGENTKIT_MODE=llm

# Session-wide spend cap (~$5, G5): every agent process reads and adds to this file.
X402_LLM_SPEND_FILE="$(mktemp -t x402-llm-spend)"
export X402_LLM_SPEND_FILE
echo 0 > "$X402_LLM_SPEND_FILE"

pnpm x402-redteam run \
  --agent "node --import tsx examples/third-party/agentkit/src/agent.ts" \
  --pass-env "ANTHROPIC_API_KEY,X402_AGENTKIT_MODE,X402_LLM_MODEL,X402_LLM_MAX_TURNS,X402_LLM_BUDGET_USD,X402_LLM_SESSION_BUDGET_USD,X402_LLM_SPEND_FILE,X402_LLM_POLICY_HINTS" \
  --timeout 180 \
  --agent-id agentkit-llm \
  --guardrail-id none-llm-judgement \
  "$@" || status=$?
echo "LLM session estimated spend: \$$(cat "$X402_LLM_SPEND_FILE")"
rm -f "$X402_LLM_SPEND_FILE"
exit "${status:-0}"
