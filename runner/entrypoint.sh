#!/bin/sh
set -eu

: "${REPO:?REPO env var required}"       # always "owner/name" — the broker normalizes it
: "${GH_TOKEN:?GH_TOKEN env var required}"

# The chat channel's formatting capability profile (e.g. Matrix needs
# plain-text-only agent output) is injected by the broker as AGENT_RULES.
# When present it REPLACES the baked-in default (opencode-rules.md), which
# exists only for standalone/manual pods not provisioned by the broker.
if [ -n "${AGENT_RULES:-}" ]; then
  echo "[runner] applying channel agent rules from env..."
  printf '%s\n' "$AGENT_RULES" > /home/node/.config/opencode/channel-rules.md
  # Same permission/maxSteps settings as the baked-in opencode.json below (this
  # overwrite replaces that file wholesale): "*" allow restores allow-by-default
  # for every tool — since v1.18.32's permission evaluator treats any rule NOT
  # matched by config as "ask", a config that only lists external_directory made
  # every read/edit/bash prompt mid-turn (each ask relayed to the room as an
  # approval). external_directory is redundant under "*" but kept explicit: it's
  # the deliberate choice that scratch writes outside the workspace (e.g. /tmp)
  # are harmless in this disposable pod. One deliberate guard: git push asks
  # (object rules after "*" win — findLast) and relays to the room via the
  # broker's approval flow. Loop/stall safety lives at the broker
  # (watchdog, cost cap) plus maxSteps below (bounds an agent looping forever;
  # opencode forces a text-only response at the cap).
  printf '%s\n' '{"$schema": "https://opencode.ai/config.json", "instructions": ["/home/node/.config/opencode/channel-rules.md"], "permission": {"*": "allow", "bash": {"*": "allow", "git push": "ask", "git push *": "ask"}, "external_directory": "allow"}, "agent": {"build": {"maxSteps": 200}}}' \
    > /home/node/.config/opencode/opencode.json
fi

WORKDIR=/home/node/workspace
echo "[runner] cloning ${REPO}..."
git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$WORKDIR"
cd "$WORKDIR"

echo "[runner] starting opencode server on port ${PORT:-4096}..."
exec opencode serve --hostname 0.0.0.0 --port "${PORT:-4096}"
