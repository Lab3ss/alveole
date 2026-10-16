#!/bin/sh
set -eu

# The channel's rules (plain-text output, shared-room etiquette) plus the
# assistant's persona are injected by the broker as AGENT_RULES — the broker is
# the single source of truth. When present, install them and regenerate
# opencode.json to reference them (the same permission/maxSteps settings as the
# baked-in opencode.json, which this overwrite replaces wholesale: "*" allow
# restores allow-by-default — since opencode 1.18.32 any tool not matched by
# config is "ask", which would relay every action to the room as an approval).
# Loop/stall safety lives at the broker (watchdog, cost cap) plus maxSteps.
if [ -n "${AGENT_RULES:-}" ]; then
  echo "[runner] applying channel agent rules from env..."
  printf '%s\n' "$AGENT_RULES" > /home/node/.config/opencode/channel-rules.md
  printf '%s\n' '{"$schema": "https://opencode.ai/config.json", "instructions": ["/home/node/.config/opencode/channel-rules.md"], "permission": {"*": "allow", "bash": {"*": "allow"}, "external_directory": "allow"}, "agent": {"build": {"maxSteps": 200}}}' \
    > /home/node/.config/opencode/opencode.json
fi

# No repo: an empty, disposable workspace. It dies with the container.
WORKDIR=/home/node/workspace
mkdir -p "$WORKDIR"
cd "$WORKDIR"

echo "[runner] starting opencode server on port ${PORT:-4096}..."
exec opencode serve --hostname 0.0.0.0 --port "${PORT:-4096}"
