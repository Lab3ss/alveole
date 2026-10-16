# Assistant runner — one ephemeral container per room per assistant bot, no
# persistent storage and no repo. Runs a headless opencode server on the room's
# chosen model; the broker drives it over HTTP (see src/harness/opencode/opencode.ts).
# Web access comes from opencode's built-in tools — nothing extra is installed.
FROM node:22-bookworm-slim

# Pin the opencode version: it MUST equal EXPECTED_OPENCODE_VERSION in
# src/harness/opencode/opencode.ts (test/harness/opencode/runner-version.test.ts
# fails if they drift). Bump deliberately, together with the coding runner.
ARG OPENCODE_VERSION=1.18.32

# ca-certificates for TLS (web fetches, OpenRouter). No git/gh: no repo here.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit "opencode-ai@${OPENCODE_VERSION}"

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown node:node /entrypoint.sh

# Permission/maxSteps defaults as opencode's global config. The channel rules
# are NOT baked here: the broker injects them as AGENT_RULES, which
# entrypoint.sh installs at runtime.
COPY opencode.json /home/node/.config/opencode/opencode.json
# chown the directory itself: entrypoint.sh writes channel-rules.md and a
# rules-referencing opencode.json into it at runtime as `node`.
RUN chown -R node:node /home/node/.config/opencode

USER node
WORKDIR /home/node
ENTRYPOINT ["/entrypoint.sh"]
