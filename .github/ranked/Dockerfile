# The ranked container image (ADR-011 Tier 1 and Tier 2, ADR-023). release-image.yml
# builds it once per release, pushes it to GHCR and attests its digest; rank.yml and
# ranked-run.yml verify that attestation and pull the image by the digest recorded in
# results/_harness.json, so every ranked result names the exact image that produced it.
# `age` is installed here, at image build time, never on the runner's host - decryption
# of the held-out corpus happens entirely inside this container.
#
# Not built locally (no docker in this repository's tooling) - statically authored only.
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

# age: https://github.com/FiloSottile/age - pinned release tarball, verified against its
# own published sha256 at build time (fails the image build if it doesn't match, so a
# compromised mirror can't silently swap the binary).
ARG AGE_VERSION=1.2.1
ARG AGE_SHA256=7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50
# procps provides `pkill`: `spawn.ts`'s `killAgentUidProcesses` throws if it is missing
# rather than skipping the post-run agentUid sweep, so it must be here.
#
# The apt packages are not version-pinned. Debian bookworm's mirrors keep only the
# current version of each package, so a pinned version stops installing as soon as a
# security update lands. Reproducibility comes from building once per release instead:
# the published image is addressed by digest, and its SBOM lists the exact package
# versions it contains.
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
# has nothing to ask once this image runs - release-image.yml instead passes the release
# commit in as this build arg, which `packages/cli/src/run.ts`'s harness-commit resolution
# reads back out of this env var, ahead of ever trying `git` itself. Left unset (plain
# `docker build .` outside that workflow), the harness falls back to `git`/"unknown"
# exactly as it would anywhere else. Declared here, after every dependency-install
# layer above, so a new commit (a new build-arg value) only invalidates this layer and
# the lightweight ones below it, never the slow `apt-get`/age-download/`pnpm install`
# layers.
ARG HARNESS_COMMIT=unknown
ENV X402_HARNESS_COMMIT=${HARNESS_COMMIT}

# OCI labels, set by release-image.yml through build args.
ARG IMAGE_SOURCE=unknown
ARG IMAGE_VERSION=unknown
LABEL org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${HARNESS_COMMIT}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.title="x402-redteam-ranked" \
      org.opencontainers.image.licenses="MIT"

# ranked-run.yml's own entrypoint script: age-decrypts /heldout-encrypted into /corpus
# (mode 0400, root-owned) using $AGE_KEY, then execs the harness CLI with whatever args
# this image was run with (--agent-uid, --guardrail, --season-seed-env, --redact, ...).
COPY .github/ranked/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
