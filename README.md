# Alvéole

Your coding agent lives in an isolated, ephemeral filesystem — one for each
of your projects. Self-host the open-source stack, then work and collaborate
from anywhere, in any Matrix client.

## Motivation

Coding agents belong where your conversations already live, not behind
another web app. Alvéole turns a Matrix room into a sealed workspace with a
real coding agent inside:

- 🔒 **Compartmentalized by design** — every room is an isolated, disposable
  workspace. Your GitHub token lives in exactly one and dies with it; shell
  commands and `git push` pause for your approval before they run.
- 🛡️ **Sovereign** — self-hosted on your own infrastructure, any OpenRouter
  model. No closed SaaS, no vendor pricing, no lock-in. Your keys, your data,
  your rules.
- 🗂️ **One channel, one project, one filesystem** — as many parallel agents
  as you have repos, each sealed in its own room, all served by one
  always-on broker.
- 👥 **Collaboration built-in** — the session lives in a chat room: invite a
  colleague, they see everything and can chime in. No seats, no dashboards.
- 📱 **Phone, web, desktop** — the room follows you across devices; pick up
  the session wherever you are.

## Components

Four building blocks, each replaceable by design:

- **Matrix** — the transport. Open, federated, self-hostable, with clients
  for phone, web, and desktop. Any other chat platform is a new adapter; the
  core doesn't change.
- **The orchestrator** — the core. Onboarding, approvals, guardrails, and
  workspace lifecycle, transport-neutral: it never mentions Matrix, k8s, or
  docker.
- **opencode** — the agent. Headless server mode, built-in permission
  gates, model-agnostic. Anything exposing a similar API could take its
  place.
- **OpenRouter** — the models. One key for hundreds of them, with usage and
  cost reporting; swap mid-session without touching a room.

## How to install

### docker-compose

The self-host path: one machine, one command. A bundled Matrix homeserver
([continuwuity](https://continuwuity.org), conduwuit's maintained successor),
[Element Web](https://element.io), and the broker, with per-room runners as
plain Docker containers (`WORKSPACE_BACKEND=compose`; k8s remains the default
backend in code).

1. Requirements: Docker with the compose plugin, and port 8080 free.
2. `cp .env.example .env`, then set in `.env`:
   - `OPENROUTER_API_KEY` — your [OpenRouter](https://openrouter.ai) key;
   - `REGISTRATION_TOKEN` — generate one: `openssl rand -hex 12` (the bundled
     homeserver only accepts token registrations; the bootstrap uses it to
     create your account and the bot's);
   - to chat from a phone or another machine: `HOMESERVER_PUBLIC_URL=http://<server-LAN-ip>:8008`
     and `MATRIX_SERVER_NAME=<server-LAN-ip>` (leave both at their defaults to
     use it on the host only).
3. Build the runner image once (it runs your repos, so it's built locally):

   ```sh
   docker compose --profile build -f deploy/docker-compose.yml --env-file .env build runner-image
   ```

4. Start everything:

   ```sh
   docker compose -f deploy/docker-compose.yml --env-file .env up -d
   ```

5. `docker compose -f deploy/docker-compose.yml logs bootstrap` prints the
   credentials block: open Element Web (port 8080 of the server), sign in with
   the printed username/password, and say hi in the room. The bot asks for a
   repo, a GitHub PAT scoped to it, and a model — then it works exactly as in
   any other room.

Notes:

- `docker compose down` stops broker/homeserver/Element but leaves live room
  runners alone (they're runtime containers, not compose services); the
  broker re-attaches to their networks lazily on its next message.
- `COMPOSE_PROFILES=""` (with `MATRIX_HOMESERVER` + `MATRIX_TOKEN` in `.env`)
  starts the broker alone against the Matrix homeserver of your choice — the
  bootstrap and bundled homeserver don't exist in that mode.
- **Security**: mounting `/var/run/docker.sock` into the broker gives it
  root-equivalent power on the host — that's how it starts room containers.
  Run rootless Docker or Podman for a hardened setup, and keep the default
  binds (only Element's 8080 is published; 8008 stays on loopback, so the
  homeserver's token-gated registration is never reachable from outside).

### k8s

Requirements: a Kubernetes cluster (runs on K3s), Node 22+ if building the
broker image yourself, a Matrix account for the bot, an
[OpenRouter](https://openrouter.ai) API key, and GitHub PATs scoped to the
repos you'll onboard.

Two images, both `linux/amd64`:

- `ghcr.io/lab3ss/coding-agent` — the broker (built from this repo's
  `Dockerfile`).
- `ghcr.io/lab3ss/coding-agent-runner` — the runner (built from
  `runner/Dockerfile`).

Deploy the broker as a single Deployment with these env vars (a k8s Secret
via `envFrom` works well):

| Var | Purpose |
|-----|---------|
| `MATRIX_HOMESERVER`, `MATRIX_TOKEN` | the bot's Matrix account |
| `OPENROUTER_API_KEY` | the only LLM credential, copied into every room's pod |
| `WORKSPACE_BACKEND` | `k8s` (default) or `compose` — which infra driver provisions per-room workspaces |
| `ROOMS_NAMESPACE` | where per-room pods live; default `coding-agent-rooms` |
| `RUNNER_IMAGE` | runner image tag; default `ghcr.io/lab3ss/coding-agent-runner:0.3.0` |
| `IDLE_TEARDOWN_HOURS` | idle threshold before auto-teardown; default `24` |
| `TURN_WATCHDOG_MINUTES` | abort a turn with no agent activity this long (approval waits exempt); default `15`, `0` disables |
| `TURN_MAX_HOURS` | absolute turn duration cap; default `4`, `0` disables |
| `SESSION_COST_CAP_USD` | abort a turn once the session's cost reaches this — the circuit-breaker against a looping agent; default `10`, `0` disables |

Notes:

- The broker must run **in-cluster** (it uses the pod's ServiceAccount to
  create Pods/Secrets/Services in `ROOMS_NAMESPACE` — set up the RBAC for
  that namespace and nothing more).
- The broker's registry (SQLite) should live on a PVC so room configs
  survive restarts.
- Use a `Recreate` strategy: a restart interrupts in-flight tasks, but
  nothing is lost — rooms re-provision on their next message.

For local development without a cluster, copy `.env.example` to `.env` and
run `npm run broker` (Kubernetes calls still need in-cluster access, so
testing against a deployed pod is the practical path).

## Usage

1. Invite the bot to an **unencrypted** Matrix room (E2EE is not supported —
   see [Security](#security)).
2. Answer its three onboarding questions: repo, GitHub PAT, model.
3. Send tasks in plain language. The agent works and reports back.

Commands:

- `/model [id]` — show or change the room's model (any
  [OpenRouter](https://openrouter.ai/models) model id), effective on the next
  message.
- `/usage` — session cost, token breakdown, context-compaction status.
  A one-line alert every $5 spent.
- `/connect` — (k8s deployments) replies with the `kubectl port-forward` +
  `opencode attach` commands to drive the same session from a local opencode
  TUI (VPN/cluster network required).
- `/stop` — tear the room's workspace down on demand. Idle rooms tear down
  automatically after `IDLE_TEARDOWN_HOURS`. The room's repo/token/model are
  remembered, so the next message re-provisions without re-asking — but
  starts a **fresh** session (no conversation memory survives a teardown).

## How it works

Two pieces:

- **The broker** — a single always-on bot holding only a Matrix account and
  an OpenRouter key. When invited to a new room it asks for a repo, a GitHub
  PAT scoped to that repo, and a model, then provisions an isolated
  workspace (a pod on k8s, a container on docker-compose) for that room.
  Chat transport is an adapter; the conversation logic is transport-neutral,
  so another chat platform is a new adapter and nothing else.
- **The runner** — a minimal throwaway image that clones the room's repo and
  runs a headless `opencode serve`. Nothing persists: a fresh pod means a
  fresh clone and a fresh session. The broker relays opencode's own
  permission prompts (shell commands, `git push`, …) back into the room as
  yes/no questions.

## Security

- **No standing repo access** — the broker holds nothing that can reach a
  GitHub repo; each room's PAT lives only in that room's Secret, inside that
  room's pod, deleted on teardown.
- **Untrusted-workload boundary** — runner pods are non-root, have no
  Kubernetes API access (`automountServiceAccountToken: false`), and run in
  a dedicated namespace only the broker can reach.
- **Approval gate** — opencode's permission prompts (shell commands,
  `git push`, etc.) pause and ask in the room before running.
- **Rooms are unencrypted** — `matrix-bot-sdk` has no E2EE provider wired
  in, so the bot can't decrypt messages in an encrypted room. The PAT
  message is redacted from room history right after the broker reads it
  (best-effort), which reduces plaintext exposure but doesn't replace
  transport encryption. Don't onboard repos whose PAT in room history is
  unacceptable to you.

## Development

```sh
npm install
npm run check   # typecheck
npm test        # unit tests
docker buildx build --platform linux/amd64 -t ghcr.io/lab3ss/coding-agent:X.Y.Z --push .
```

## License

MIT
