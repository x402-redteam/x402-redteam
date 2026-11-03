#!/usr/bin/env bash
# Runs the AgentKit adapter in llm mode through the harness (U25 §3.3), the way
# examples/agents/scripts/run-llm.sh runs the built-in LLM agent.
#
# Manual, non-CI use only (G5, G8). Key-file mode (U35, M5): the Anthropic key is read from a
# file named by X402_ANTHROPIC_KEY_FILE, a regular file of mode 0600 (it may live under
# ~/x402-redteam-private/, which the sandboxed child cannot read). Only the path travels
# through the environment (--pass-env), so the key is in no process's exec environment, and
# only the adapter's parent process reads it into memory. The script refuses to start if
# ANTHROPIC_API_KEY is also exported (the key would then be in the environment anyway; do not
# export it in your shell), and refuses an ANTHROPIC_API_KEY on its own: a third-party child
# runs under this script, so the file is required. If no key file is named, this prints
# SKIPPED and exits 0 without starting the harness.
#
# Results stay outside the repository (ADR-028): always pass --out under
# ~/x402-redteam-private/bolt8/agentkit/.
#
# Usage: examples/third-party/agentkit/scripts/run-llm.sh --chains evm --out <dir> [args...]
#   e.g. examples/third-party/agentkit/scripts/run-llm.sh --chains evm \
#          --scenario control-paid-fetch --out ~/x402-redteam-private/bolt8/agentkit/llm-smoke
set -euo pipefail

if [ -n "${X402_ANTHROPIC_KEY_FILE:-}" ]; then
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    echo "REFUSED: X402_ANTHROPIC_KEY_FILE is set and ANTHROPIC_API_KEY is also exported; unset ANTHROPIC_API_KEY" >&2
    exit 1
  fi
  if [ ! -f "$X402_ANTHROPIC_KEY_FILE" ] || [ -L "$X402_ANTHROPIC_KEY_FILE" ]; then
    echo "REFUSED: X402_ANTHROPIC_KEY_FILE is not a regular file" >&2
    exit 1
  fi
  mode="$(stat -f '%Lp' "$X402_ANTHROPIC_KEY_FILE" 2>/dev/null || stat -c '%a' "$X402_ANTHROPIC_KEY_FILE")"
  if [ "$mode" != "600" ]; then
    echo "REFUSED: X402_ANTHROPIC_KEY_FILE must have mode 0600" >&2
    exit 1
  fi
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "REFUSED: a third-party child runs under this script; put the key in a 0600 file and set X402_ANTHROPIC_KEY_FILE (and unset ANTHROPIC_API_KEY)" >&2
  exit 1
else
  echo "SKIPPED: X402_ANTHROPIC_KEY_FILE not set"
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd "$script_dir/../../../.." && pwd)"
cd "$root_dir"

export X402_AGENTKIT_MODE=llm

# Session-wide spend cap (~$5, G5): every agent process reads and adds to this file. It lives
# in its own 0700 directory, removed on exit, so it is outside every path a sandboxed child may
# write (a child's only writable path is its own fresh HOME) and the cap cannot be bypassed.
spend_dir="$(mktemp -d "${TMPDIR:-/tmp}/x402-llm-spend.XXXXXX")"
trap 'rm -rf "$spend_dir"' EXIT
chmod 700 "$spend_dir"
case "$spend_dir" in
  *x402rt-*-home-*) echo "REFUSED: the spend directory is under a child HOME" >&2; exit 1 ;;
esac
X402_LLM_SPEND_FILE="$spend_dir/spend"
export X402_LLM_SPEND_FILE
echo 0 > "$X402_LLM_SPEND_FILE"

pnpm x402-redteam run \
  --agent "node --import tsx examples/third-party/agentkit/src/agent.ts" \
  --pass-env "X402_ANTHROPIC_KEY_FILE,X402_AGENTKIT_MODE,X402_LLM_MODEL,X402_LLM_MAX_TURNS,X402_LLM_BUDGET_USD,X402_LLM_SESSION_BUDGET_USD,X402_LLM_SPEND_FILE,X402_LLM_POLICY_HINTS" \
  --timeout 180 \
  --agent-id agentkit-llm \
  --guardrail-id none-llm-judgement \
  "$@" || status=$?
echo "LLM session estimated spend: \$$(cat "$X402_LLM_SPEND_FILE")"
exit "${status:-0}"
