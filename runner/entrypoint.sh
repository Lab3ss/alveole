#!/bin/sh
set -eu

: "${REPO:?REPO env var required}"       # always "owner/name" — the broker normalizes it
: "${GH_TOKEN:?GH_TOKEN env var required}"

# The chat channel's formatting capability profile (e.g. Matrix needs
# plain-text-only agent output) is injected by the broker as AGENT_RULES — the
# broker is the single source of truth for these rules. When present, install
# them and regenerate opencode.json to reference them; the broker always sets
# this, so the fallback (the baked opencode.json, no instructions) only applies
# to a runner started by hand.
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

# Git commit identity. Resolved once at boot and written as GLOBAL git config —
# deliberately NOT exported as GIT_AUTHOR_*/GIT_COMMITTER_* env vars, which
# would shadow any later in-place override (`/git-name`, `/git-email` rewrite
# the config through the opencode shell during the room's lifetime). Priority:
# an explicit broker override (GIT_USER_NAME/GIT_USER_EMAIL, set per room via
# those commands) > the GitHub account behind GH_TOKEN > a neutral fallback.
# GitHub's email is often null (private), so we fall back to the account's
# noreply address, which still attributes commits to the account.
echo "[runner] resolving git identity..."
node -e '
const { execFileSync } = require("node:child_process");
(async () => {
  let name = process.env.GIT_USER_NAME || "";
  let email = process.env.GIT_USER_EMAIL || "";
  if (!name || !email) {
    try {
      const res = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: "Bearer " + process.env.GH_TOKEN,
          Accept: "application/vnd.github+json",
          "User-Agent": "alveole-runner",
        },
      });
      if (res.ok) {
        const u = await res.json();
        name = name || u.name || u.login || "";
        email = email || u.email || (u.id && u.login ? u.id + "+" + u.login + "@users.noreply.github.com" : "");
      } else {
        console.error("[runner] github identity lookup: HTTP " + res.status);
      }
    } catch (err) {
      console.error("[runner] github identity lookup failed: " + (err && err.message ? err.message : err));
    }
  }
  name = name || "Alveole Agent";
  email = email || "alveole-agent@users.noreply.github.com";
  execFileSync("git", ["config", "--global", "user.name", name]);
  execFileSync("git", ["config", "--global", "user.email", email]);
  console.log("[runner] git identity: " + name + " <" + email + ">");
})();
'

WORKDIR=/home/node/workspace
echo "[runner] cloning ${REPO}..."
git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$WORKDIR"
cd "$WORKDIR"

echo "[runner] starting opencode server on port ${PORT:-4096}..."
exec opencode serve --hostname 0.0.0.0 --port "${PORT:-4096}"
