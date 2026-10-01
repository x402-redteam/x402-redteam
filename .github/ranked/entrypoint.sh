#!/bin/sh
# U19 (ADR-011 Tier 1/Tier 2 containers): runs as root inside the ranked-run / rank
# image. Shared by ranked-run.yml (held-out corpus, AGE_KEY/SEASON_SEED set, --redact)
# and rank.yml (public corpus, neither secret set, no --redact) - this script only
# decrypts a held-out corpus when AGE_KEY is actually present.
#
# 1. If AGE_KEY is set, age-decrypts the held-out corpus bundle (mounted read-only at
#    /heldout-encrypted) into /corpus, then locks it to mode 0400 (root-readable only -
#    the harness itself runs as root; the driver/guardrail/agent run unprivileged via
#    --agent-uid). Otherwise /corpus is whatever the image's own public corpus/ is.
# 2. Never echoes $AGE_KEY or $SEASON_SEED, and never writes either to a file that
#    survives this script.
# 3. Security review HIGH-4: the harness writes to a root-only *internal* directory
#    (/root-out, mode 0700) - never directly to the externally-mounted /out, which a
#    bind mount could expose mid-run. Only after the harness process exits are the
#    finished report file(s) copied to /out, with their own permissions set explicitly.
# 4. Security review MEDIUM-10: age decrypts to a file and its own exit status is
#    checked *before* `tar` ever runs - never a pipe, which would mask a decrypt
#    failure behind tar's own exit code.
#
# NOT run here (no docker/age installed in this worktree) - statically authored only.
set -eu

CORPUS_DIR=/corpus

if [ -n "${AGE_KEY:-}" ]; then
  mkdir -p "$CORPUS_DIR"
  BUNDLE="$(find /heldout-encrypted -maxdepth 1 -name '*.tar.age' | head -n1)"
  if [ -z "$BUNDLE" ]; then
    echo "entrypoint.sh: no *.tar.age bundle found under /heldout-encrypted" >&2
    exit 2
  fi

  AGE_IDENTITY="$(mktemp)"
  DECRYPTED_TAR="$(mktemp)"
  cleanup_decrypt() { rm -f "$AGE_IDENTITY" "$DECRYPTED_TAR"; }
  trap cleanup_decrypt EXIT
  printf '%s\n' "$AGE_KEY" >"$AGE_IDENTITY"

  if ! age -d -i "$AGE_IDENTITY" -o "$DECRYPTED_TAR" "$BUNDLE"; then
    echo "entrypoint.sh: age decryption failed" >&2
    exit 2
  fi
  rm -f "$AGE_IDENTITY"

  tar -x -C "$CORPUS_DIR" -f "$DECRYPTED_TAR"
  rm -f "$DECRYPTED_TAR"
  trap - EXIT

  chmod -R 0400 "$CORPUS_DIR"
  find "$CORPUS_DIR" -type d -exec chmod 0500 {} +
else
  CORPUS_DIR=/harness/corpus
fi

mkdir -m 0700 -p /root-out
set +e
node /harness/packages/cli/bin/x402-redteam.mjs run --corpus "$CORPUS_DIR" --out /root-out "$@"
STATUS=$?
set -e

mkdir -p /out
# Security re-review 1-residual: report.redacted.json (when present - ranked-run.yml
# always passes --redact) is the ONLY thing ever copied out; the full report.json
# (which carries runs[], prompts, hosts and violation messages - exactly what Tier 1
# must never publish, ADR-011) is only copied when no redacted report exists at all
# (rank.yml's own Tier 2 invocation, which never passes --redact) - never both.
if [ -f /root-out/report.redacted.json ]; then
  cp /root-out/report.redacted.json /out/report.redacted.json
  chmod 0644 /out/report.redacted.json
elif [ -f /root-out/report.json ]; then
  cp /root-out/report.json /out/report.json
  chmod 0644 /out/report.json
fi

exit "$STATUS"
