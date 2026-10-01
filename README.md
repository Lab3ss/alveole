# Alvéole 🐝🤖

Your coding agent lives in an isolated, ephemeral filesystem — one for each
of your projects. Self-host the open-source stack, then work and collaborate
from anywhere, in any Matrix client.

## Motivation

- 🔒 **Compartmentalized by design** — every room is an isolated, disposable
  workspace running inside its own pod or container. Your GitHub token lives in exactly one and dies with it;
- 🛡️ **Sovereign** — self-hosted on your own infrastructure, any OpenRouter
  model. No closed SaaS, no vendor pricing, no lock-in. Your keys, your data,
  your rules.
- 🗂️ **One channel, one project, one filesystem** — as many parallel agents
  as you have repos or even tasks, each sealed in its own room, all served by one
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

## Installation

### A. Running locally using *docker-compose*

_Pick this to self-host everything on one machine — All is up in five minutes._

#### 1. Requirements

All you need is Docker with the compose plugin (bundled with Docker
Desktop; on Linux it's the `docker-compose-plugin` package) and this repository cloned locally.

#### 2. Configuration (if you DO NOT HAVE an account on an existing Matrix homeserver)

This is the batteries-included path: the compose stack brings up a full
Matrix homeserver ([continuwuity](https://continuwuity.org)) and the
Element Web chat client, then a one-shot bootstrap registers two accounts
on that fresh homeserver for you — the bot's and yours — and creates the
private room you'll chat in. All happens inside the stack.

Copy `.env.example` to `.env` and set:

- `OPENROUTER_API_KEY` — your [OpenRouter](https://openrouter.ai) key: the
  single LLM credential; every room's agent bills its model calls through
  it;

> ⚠️ to work from a phone or another device, this device must be able to reach
> `HOMESERVER_PUBLIC_URL=http://<server-LAN-ip>:8008` and `MATRIX_SERVER_NAME=<server-LAN-ip>`

  **Recommendation**: Once you validated Alveole fits your needs, self host your own persistent Matrix Homeserver or create an account on [Matrix.org](https://matrix.org/docs/chat_basics/matrix-for-im/#creating-a-matrix-account) or any Homeserver so you will be able to use any Matrix client you want (Mobile, Web or Desktop) and work from everywhere.

#### 2. Configuration (if you already DO HAVE a Matrix Homeserver account)

If Matrix is already part of your life — your own homeserver, or an
account on one — you need none of that bundled plumbing. The broker is the
only component that ever speaks Matrix: point it at your homeserver and
give it an account to sign in as, and it joins rooms like any other user.

Copy `.env.example` to `.env` and set:

- `OPENROUTER_API_KEY` — your [OpenRouter](https://openrouter.ai) key: the
  single LLM credential; every room's agent bills its model calls through
  it;
- `MATRIX_HOMESERVER` — the URL of your homeserver;
- `MATRIX_TOKEN` — an access token for the bot's account, a dedicated user
  on that homeserver that the broker signs in as (most clients can print
  one — in Element: Settings → Help & About → Access Token);
- comment out the `COMPOSE_PROFILES` line in `.env` — it decides which
  services come up; removing it leaves out the included homeserver, Element
  Web, and the bootstrap: only the broker runs, against your homeserver.

One constraint to know upfront: the bot cannot decrypt encrypted rooms, so
onboard it in unencrypted ones (see [Security](#security)).

#### 3. Build the runner

Every room gets its own throwaway container that clones the repo and runs
the agent inside — that's the runner image. It isn't published anywhere:
it's built from this repo, on this machine, because it's what executes
your code. Build it once; every room reuses it afterwards:

```sh
docker compose --profile build -f deploy/docker-compose.yml --env-file .env build runner-image
```

#### 4. Start

Bring the stack up in the background.

```sh
docker compose -f deploy/docker-compose.yml --env-file .env up -d
```

#### 5. Enjoy

The stack is up; step into the room.

- Matrix-included mode: `docker compose -f deploy/docker-compose.yml --env-file .env logs bootstrap`
  prints a credentials block — the Element Web URL (port 8080 of the
  server) and the username/password the bootstrap generated for you. Open
  Element, sign in, and the room is already there, with the bot waiting.

- External Matrix mode: from your usual client, create an unencrypted room and
  invite the bot's user; it joins and starts the same onboarding (see
  [Usage](#usage)).

Then say hi: the bot walks you through three questions — which repo to work
on, a GitHub PAT scoped to that repo (it lives only inside that room's
runner and dies with it — see [Security](#security)), and which
[OpenRouter](https://openrouter.ai) model to use. From then on, just send
tasks in plain language.

Notes:

- `docker compose down` stops the compose services (broker, plus
  homeserver/Element in matrix-included mode) but leaves live room runners alone
  (they're runtime containers, not compose services); the broker re-attaches
  to their networks lazily on its next message.
- **Security**: mounting `/var/run/docker.sock` into the broker gives it
  root-equivalent power on the host — that's how it starts room containers.
  Run rootless Docker or Podman for a hardened setup, and keep the default
  binds (only Element's 8080 is published; 8008 stays on loopback, so the
  homeserver's token-gated registration is never reachable from outside).

### B. Add to your cluster using *k8s*

_Pick this if you already run a cluster — per-room pods land in it, next to
your other workloads._

Requirements, in plain terms:

- a Kubernetes cluster — any cluster works; it's exercised on K3s. Each
  room you onboard becomes a Pod in it;
- Node 22+ — only if you build the broker image yourself (both images are
  published on ghcr for `linux/amd64`, so most people skip this);
- a Matrix account for the bot — a dedicated user on the homeserver of
  your choice; the broker signs in as that user with an access token (see
  the env vars below), and only in unencrypted rooms (no E2EE);
- an [OpenRouter](https://openrouter.ai) API key — the single LLM
  credential, copied into every room's pod;
- GitHub PATs scoped to the repos you'll onboard — one per repo, asked in
  the room at onboarding, living only inside that room's pod.

Two images, both `linux/amd64` — pull them from ghcr, or build them from
this repo:

- `ghcr.io/lab3ss/alveole` — the broker, the always-on core: it signs
  into Matrix, listens in rooms, and provisions each room's workspace
  (built from this repo's `Dockerfile`).
- `ghcr.io/lab3ss/alveole-runner` — the runner, what each room's pod
  actually runs: a disposable, isolated workspace with the agent inside
  (built from `runner/Dockerfile`).

The broker is the only thing you deploy: one Deployment, in-cluster, fed
these env vars (a k8s Secret via `envFrom` works well). In order, they
tell it who it is on Matrix, what it may spend, where rooms live, and how
hard it may push (the guardrails):

| Var | Purpose |
|-----|---------|
| `MATRIX_HOMESERVER`, `MATRIX_TOKEN` | the bot's Matrix account |
| `OPENROUTER_API_KEY` | the only LLM credential, copied into every room's pod |
| `WORKSPACE_BACKEND` | which infra driver provisions per-room workspaces: `k8s` or `compose`. The shipped `.env.example` sets `compose`; the code default is `k8s` |
| `ROOMS_NAMESPACE` | where per-room pods live; default `coding-agent-rooms` |
| `RUNNER_IMAGE` | runner image tag; default `ghcr.io/lab3ss/alveole-runner:0.3.0` |
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

For local development, copy `.env.example` to `.env` (its
`WORKSPACE_BACKEND=compose` provisions runner containers through the local
docker daemon) and run `npm run broker`, which loads `.env` automatically.
The `k8s` backend calls `kc.loadFromCluster()` and only works inside a real
pod, so testing it locally means running against a deployed pod.

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

## Security

- **No standing repo access** — the broker holds nothing that can reach a
  GitHub repo; each room's PAT lives only in that room's Secret (its env file
  on compose), inside that room's runner, deleted on teardown.
- **Isolated, disposable runners** — one throwaway runner per room: its own
  filesystem, its own clone, its own network, zero shared state with any
  other room. Runners are non-root and hold no cluster credentials (k8s:
  `automountServiceAccountToken: false`, a dedicated namespace only the
  broker can reach) and no docker socket — the only components that ever
  touch infrastructure are the broker and your own CLI.
- **Nothing persists, automatically** — a room torn down after
  `IDLE_TEARDOWN_HOURS` of idleness (default 24h) or via `/stop` leaves
  nothing behind: the runner, its network, and its Secret/env file are
  deleted, and the PAT goes with them. The room's repo/token/model settings
  survive in the registry, but the next message re-provisions from a fresh
  clone and a fresh session — no conversation memory, no stale artifacts.
- **Approval gate** — opencode's permission prompts (shell commands,
  `git push`, etc.) pause and ask in the room before running.
- **Rooms are unencrypted** — `matrix-bot-sdk` has no E2EE provider wired
  in, so the bot can't decrypt messages in an encrypted room. The PAT
  message is redacted from room history right after the broker reads it
  (best-effort), which reduces plaintext exposure but doesn't replace
  transport encryption. Don't onboard repos whose PAT in room history is
  unacceptable to you.

## License

MIT
