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
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

# age: https://github.com/FiloSottile/age - pinned release tarball, verified against its
# own published sha256 at build time (fails the image build if it doesn't match, so a
# compromised mirror can't silently swap the binary).
ARG AGE_VERSION=1.2.1
ARG AGE_SHA256=7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50
# Security re-review 4-residual: procps provides `pkill` - `spawn.ts`'s
# `killAgentUidProcesses` now *fails loudly* (throws) if it's missing, rather than
# silently skipping the post-run agentUid sweep, so it must actually be here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /tmp/age.tar.gz \
       "https://github.com/FiloSottile/age/releases/download/v${AGE_VERSION}/age-v${AGE_VERSION}-linux-amd64.tar.gz" \
    && echo "${AGE_SHA256}  /tmp/age.tar.gz" | sha256sum -c - \
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

# `.dockerignore` excludes `.git` from this image on purpose, so `git rev-parse HEAD`
# has nothing to ask once this image runs - rank.yml/ranked-run.yml instead resolve the
# checked-out harness's own commit on the runner (where `.git` IS present) and pass it
# in as this build arg, which `packages/cli/src/run.ts`'s harness-commit resolution
# reads back out of this env var, ahead of ever trying `git` itself. Left unset (plain
# `docker build .` outside those workflows), the harness falls back to `git`/"unknown"
# exactly as it would anywhere else. Declared here, after every dependency-install
# layer above, so a new commit (a new build-arg value) only invalidates this layer and
# the lightweight ones below it, never the slow `apt-get`/age-download/`pnpm install`
# layers.
ARG HARNESS_COMMIT=unknown
ENV X402_HARNESS_COMMIT=${HARNESS_COMMIT}

# ranked-run.yml's own entrypoint script: age-decrypts /heldout-encrypted into /corpus
# (mode 0400, root-owned) using $AGE_KEY, then execs the harness CLI with whatever args
# this image was run with (--agent-uid, --guardrail, --season-seed-env, --redact, ...).
COPY .github/ranked/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
