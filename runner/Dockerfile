# Room runner — one ephemeral pod per Matrix room, no persistent storage.
# Clones the room's repo (GH_TOKEN from env, supplied at onboarding, never
# baked into the image) and runs a headless opencode server on the room's
# chosen model/provider; the broker drives it over HTTP (see src/opencode.ts).
FROM node:22-bookworm-slim

# Pin the opencode version: an unpinned `npm install -g opencode-ai` makes
# every image rebuild a potential silent major-version jump (breaking runner
# behavior/APIs between otherwise identical deployments). Bump deliberately.
ARG OPENCODE_VERSION=1.18.32

# Python toolchain, alongside the base image's Node. This is the pragmatic middle
# ground for "multi-language repos": one shared image that covers the common
# Node + Python case, so the agent can run pytest/ruff/etc. out of the box.
# uv is pinned for the same reason as opencode above — it drives venv creation
# (and can install its own Python interpreters) so projects using
# pyproject.toml/uv.lock work without extra setup. For other stacks (Go, Rust,
# JVM, system deps), the intended extension point is still a per-room image
# override rather than growing this one image indefinitely.
ARG UV_VERSION=0.12.20

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
      python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit "opencode-ai@${OPENCODE_VERSION}" \
 && pip3 install --no-cache-dir --break-system-packages "uv==${UV_VERSION}"

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown node:node /entrypoint.sh

# Matrix-specific agent rules, baked in as opencode's global config so they
# apply to every room's session no matter which repo is cloned (the repo's own
# AGENTS.md still merges on top; see opencode-rules.md — currently: plain-text
# replies only, since Matrix clients don't render markdown).
COPY opencode.json /home/node/.config/opencode/opencode.json
COPY opencode-rules.md /home/node/.config/opencode/opencode-rules.md
# chown the directory itself, not just these two files: entrypoint.sh writes a
# new channel-rules.md into it at runtime as `node`, which needs dir write
# permission, not just file ownership.
RUN chown -R node:node /home/node/.config/opencode

USER node
WORKDIR /home/node
ENTRYPOINT ["/entrypoint.sh"]
