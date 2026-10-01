# U19 (ADR-011 Tier 1 "Ranked (held-out)"): the ranked-run container image, built fresh
# by ranked-run.yml on every run (never pulled from a registry, so there's nothing to
# keep patched between seasons). `age` is installed HERE, at image build time, never on
# the runner's host (CLAUDE.md: don't install age/docker/act locally) - decryption of
# the held-out corpus happens entirely inside this container.
#
# NOT built or run here (no docker in this worktree, per task constraints) - statically
# authored only. Dry-run once the org/private corpus repo exist (docs/seasons.md).
#
# Security review LOW: pin this base image by digest, not just tag, before the first
# real build - `node:20-bookworm-slim@sha256:<resolve offline-unavailable digest here>`.
# Not resolved here (no network/docker in this worktree); resolve via `docker pull
# node:20-bookworm-slim && docker inspect --format '{{index .RepoDigests 0}}'
# node:20-bookworm-slim` once docker is available, then replace the line below.
FROM node:20-bookworm-slim

# age: https://github.com/FiloSottile/age - pinned release tarball, verified against its
# own published sha256 at build time (fails the image build if it doesn't match, so a
# compromised mirror can't silently swap the binary).
ARG AGE_VERSION=1.2.1
ARG AGE_SHA256=unset-pin-the-real-checksum-before-first-build
# Security re-review 4-residual: procps provides `pkill` - `spawn.ts`'s
# `killAgentUidProcesses` now *fails loudly* (throws) if it's missing, rather than
# silently skipping the post-run agentUid sweep, so it must actually be here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /tmp/age.tar.gz \
       "https://github.com/FiloSottile/age/releases/download/v${AGE_VERSION}/age-v${AGE_VERSION}-linux-amd64.tar.gz" \
    && if [ "$AGE_SHA256" != "unset-pin-the-real-checksum-before-first-build" ]; then \
         echo "${AGE_SHA256}  /tmp/age.tar.gz" | sha256sum -c -; \
       else \
         echo "AGE_SHA256 is unset - pin it to the release's published checksum before the first real ranked-run build" >&2; \
         exit 1; \
       fi \
    && tar -xzf /tmp/age.tar.gz -C /usr/local/bin --strip-components=1 age/age age/age-keygen \
    && rm -f /tmp/age.tar.gz \
    # Security review MEDIUM-9: fail the image build immediately if the extracted
    # binary doesn't actually run, rather than discovering it at container-run time
    # deep inside entrypoint.sh.
    && age --version

# Security review HIGH-4/LOW: the unprivileged uid the driver/guardrail/agent run as
# (ranked-run.yml's own `--agent-uid 2001`, rank.yml's own `--agent-uid 2001`) - never
# 1000 or 1001 (common default runner/container uids a bind-mounted host path could
# otherwise collide with), and never 0 (`validateAgentUid` refuses both). The harness
# process itself stays root (the default user below is never set), so the held-out
# corpus can be mode 0400 - root-readable only.
RUN useradd --uid 2001 --create-home --shell /usr/sbin/nologin x402-agent

RUN corepack enable && corepack prepare pnpm@10.34.6 --activate

WORKDIR /harness
COPY . .
RUN pnpm install --frozen-lockfile

# ranked-run.yml's own entrypoint script: age-decrypts /heldout-encrypted into /corpus
# (mode 0400, root-owned) using $AGE_KEY, then execs the harness CLI with whatever args
# this image was run with (--agent-uid, --guardrail, --season-seed-env, --redact, ...).
COPY .github/ranked/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
