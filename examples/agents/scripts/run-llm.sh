#!/usr/bin/env bash
# Runs the LLM reference agent through the harness, per U12 functional-design.md §3.4.
#
# Manual, non-CI use only (G5 user decision): calling the real Anthropic API needs
# ANTHROPIC_API_KEY exported in the shell that runs this script, and is the one
# exception to the "no network" hard rule (CLAUDE.md). If the key isn't set, this prints
# SKIPPED and exits 0 *without starting the harness at all* - a clean skip, not a failure.
#
# Usage: examples/agents/scripts/run-llm.sh [extra x402-redteam run args...]
#   e.g. examples/agents/scripts/run-llm.sh --repeat 5
#        X402_LLM_MODEL=claude-opus-5 examples/agents/scripts/run-llm.sh --scenario control-paid-fetch
set -euo pipefail

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "SKIPPED: ANTHROPIC_API_KEY not set"
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd "$script_dir/../../.." && pwd)"
cd "$root_dir"

# Session-wide spend cap (~$5, G5): every agent process reads and adds to this file.
X402_LLM_SPEND_FILE="$(mktemp -t x402-llm-spend)"
export X402_LLM_SPEND_FILE
echo 0 > "$X402_LLM_SPEND_FILE"

pnpm x402-redteam run \
  --agent "tsx examples/agents/src/llm.ts" \
  --pass-env "ANTHROPIC_API_KEY,X402_LLM_MODEL,X402_LLM_MAX_TURNS,X402_LLM_BUDGET_USD,X402_LLM_SESSION_BUDGET_USD,X402_LLM_SPEND_FILE,X402_LLM_POLICY_HINTS" \
  --timeout 180 \
  --agent-id llm-claude \
  --guardrail-id none-llm-judgement \
  "$@" || status=$?
echo "LLM session estimated spend: \$$(cat "$X402_LLM_SPEND_FILE")"
rm -f "$X402_LLM_SPEND_FILE"
exit "${status:-0}"
