# Room runner — one ephemeral pod per Matrix room, no persistent storage.
# Clones the room's repo (GH_TOKEN from env, supplied at onboarding, never
# baked into the image) and runs a headless opencode server on the room's
# chosen model/provider; the broker drives it over HTTP (see src/opencode.ts).
FROM node:22-bookworm-slim

# Pin the opencode version: an unpinned `npm install -g opencode-ai` makes
# every image rebuild a potential silent major-version jump (breaking runner
# behavior/APIs between otherwise identical deployments). Bump deliberately.
ARG OPENCODE_VERSION=1.18.32

# git for the repo; gh so the agent can do GitHub operations (PRs/issues)
# directly — it authenticates non-interactively from the GH_TOKEN env var the
# broker injects, no `gh auth login` needed. ca-certificates for TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates gh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit "opencode-ai@${OPENCODE_VERSION}"

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown node:node /entrypoint.sh

# Permission/maxSteps defaults as opencode's global config. The agent's channel
# rules are NOT baked here: the broker is the single source of truth and injects
# them as AGENT_RULES, which entrypoint.sh installs at runtime (see
# src/adapter/matrix.ts's channelRules).
COPY opencode.json /home/node/.config/opencode/opencode.json
# chown the directory itself, not just the file: entrypoint.sh writes
# channel-rules.md and a rules-referencing opencode.json into it at runtime as
# `node`, which needs dir write permission, not just file ownership.
RUN chown -R node:node /home/node/.config/opencode

USER node
WORKDIR /home/node
ENTRYPOINT ["/entrypoint.sh"]
