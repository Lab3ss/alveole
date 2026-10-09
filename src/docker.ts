/**
 * Compose-mode driver — the docker counterpart of src/k8s.ts. Same call
 * signatures and lifecycle semantics (idempotent provision, watchdog,
 * self-heal via readRoomPodState, sweep teardown), but per-room runners are
 * plain Docker containers on per-room bridge networks instead of pods in a
 * namespace. No new dependency: the CLI is invoked via node:child_process
 * execFile (no shell interpolation, stderr captured, per-exec timeout), and
 * JSON where useful via `docker inspect --format '{{json .State}}'`.
 *
 * Network layout: each room gets a user-defined bridge network `room-<name>`
 * created at provision time, and the broker attaches itself to it so the
 * embedded Docker DNS resolves the room container by name (roomServerUrl).
 * These networks are created at runtime, outside compose — `docker compose
 * down` leaves them and their runners alone.
 *
 * Broker-restart reconciliation is LAZY (documented choice, spec 3): instead
 * of a broker-startup ensureNetworks sweep, the connect step (c) re-runs on
 * every provision, and makeComposeWorkspace (src/core/workspace.ts)
 * best-effort re-attaches the broker before the first HTTP call on every
 * recovery path — serverPassword is the first workspace call in
 * ensureProvisioned's recovery branch and in /usage//stop, so a broker that
 * restarted (and thereby lost its network attachments) re-joins the room's
 * network before anything actually talks HTTP. createSession additionally
 * re-connects once on a connection-refused-type failure as a belt-and-
 * suspenders. This keeps orchestrator untouched and needs no startup hook.
 *
 * Deviation from spec 3a, on purpose: AGENT_RULES is NOT stored in the env
 * file. `docker run --env-file` cannot carry multi-line values (it errors or
 * truncates), and the Matrix agent-rules profile is a multi-line markdown
 * document — it rides via a single `-e` argv entry at container create time
 * (execFile passes it verbatim, newlines included). The env file keeps the
 * four single-line secrets/state values, which is also exactly what
 * getRoomServerPassword parses back.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as k8s from "./k8s.ts";

// Same port as the k8s driver (shared export) — the runner image's opencode
// server doesn't know which backend provisioned it.
export const OPENCODE_PORT = k8s.OPENCODE_PORT;

// Names/functions shared verbatim with k8s.ts: `room-<slug>-<hash16>` is a
// valid Docker container name (alphanumerics, dashes, <=63 chars), so the
// deterministic naming — and with it the /stop -> re-provision and
// re-provision-after-idle flows — behaves identically across drivers.
export const roomResourceName = k8s.roomResourceName;
export type RoomPodState = k8s.RoomPodState;
export type RoomEnv = k8s.RoomEnv;

const RUNNER_IMAGE = process.env.RUNNER_IMAGE ?? "alveole-runner:local";
/** Broker's own container name, needed to join per-room networks. */
const BROKER_CONTAINER_NAME = process.env.BROKER_CONTAINER_NAME ?? "alveole-broker";
const RUNNER_MEM = process.env.RUNNER_MEM ?? "2g";
const RUNNER_CPUS = process.env.RUNNER_CPUS ?? "2";
/** Where the per-room env files live (persisted on the /data volume). */
const ROOMS_ENV_DIR = process.env.ROOMS_ENV_DIR ?? "/data/rooms";

/** The per-room bridge network: the room container is its only member besides the broker. */
export function roomNetworkName(name: string): string {
  return `room-${name}`;
}

/** Absolute path of a room's env file (the compose driver's "Secret"). */
export function roomEnvFilePath(name: string): string {
  return path.join(ROOMS_ENV_DIR, `${name}.env`);
}

/**
 * Parse a KEY=VALUE env file (what we write into /data/rooms and what
 * `docker run --env-file` consumes): blank lines and `#` comments ignored,
 * value runs to end of line and may itself contain `=` (GitHub tokens carry
 * base64 padding). Pure — unit-tested.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

/** The exact inverse of parseEnvFile for the room's env file. Pure — unit-tested. */
export function envFileContent(env: {
  REPO: string;
  GH_TOKEN: string;
  OPENCODE_SERVER_PASSWORD: string;
  OPENROUTER_API_KEY: string;
  GIT_USER_NAME?: string;
  GIT_USER_EMAIL?: string;
}): string {
  let out = `REPO=${env.REPO}\nGH_TOKEN=${env.GH_TOKEN}\nOPENCODE_SERVER_PASSWORD=${env.OPENCODE_SERVER_PASSWORD}\nOPENROUTER_API_KEY=${env.OPENROUTER_API_KEY}\n`;
  if (env.GIT_USER_NAME) out += `GIT_USER_NAME=${env.GIT_USER_NAME}\n`;
  if (env.GIT_USER_EMAIL) out += `GIT_USER_EMAIL=${env.GIT_USER_EMAIL}\n`;
  return out;
}

/** `docker inspect .State` — only the fields the driver reads. */
export type DockerContainerState = { Status?: string; Running?: boolean; Error?: string; ExitCode?: number; OOMKilled?: boolean };

/**
 * Container state -> the same RoomPodState the k8s driver reports, so the
 * orchestrator's self-heal works unchanged: no container = "gone" (covers
 * out-of-band `docker rm` / host reboot), Running = "running",
 * Created/Restarting/Paused = "pending" (transient), Exited/Dead = "failed"
 * (restartPolicy is `no`, so a crashed runner stays dead like a k8s
 * restartPolicy: Never pod). "removing" (mid `docker rm`) maps to "gone" —
 * same reasoning as k8s.ts's Terminating->"gone".
 */
export function inspectStateToRoomPodState(state: DockerContainerState | undefined): RoomPodState {
  if (!state) return "gone";
  if (state.Running) return "running";
  switch (state.Status) {
    case "exited":
    case "dead":
      return "failed";
    case "removing":
      return "gone";
    default: // created / restarting / paused / unknown = still transient
      return "pending";
  }
}

/**
 * The single seam tests swap out to run the whole driver against a fake
 * `execFile` (unit tests) — production always uses the real docker CLI.
 */
export type DockerExec = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const realExec: DockerExec = (file, args) =>
  new Promise((resolve, reject) => {
    // 30s bounds every CLI call (docker run with a pre-built local image
    // returns in ~1s; the only slow path, an image pull, is on the caller
    // that just built the image). execFile has no shell: args are passed
    // verbatim, so values with spaces/newlines (`-e AGENT_RULES=...`) stay
    // intact, and stderr rides on the error for the message below.
    execFile(file, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const reason = String(stderr || stdout || err.message).trim();
        reject(new Error(`${file} ${args.join(" ")} failed: ${reason}`, { cause: err }));
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });

let exec: DockerExec = realExec;

/** Test seam: swap the docker CLI runner (undefined restores the real one). */
export function setDockerExecForTests(fake: DockerExec | undefined): void {
  exec = fake ?? realExec;
}

/** True when the CLI's stderr matches an idempotency no-op ("already there"). */
function alreadyThere(err: unknown): boolean {
  return /already exists|already connected|already exists in network/i.test((err as Error)?.message ?? "");
}

/** True when the CLI reports the object doesn't exist (rm/inspect tolerances). */
function notFound(err: unknown): boolean {
  return /no such (container|network|object)/i.test((err as Error)?.message ?? "");
}

/** True when only the broker's own container is missing (test/CLI contexts —
 * the room itself is fine; the broker just can't join its network yet). */
function brokerContainerMissing(err: unknown): boolean {
  return /no such container/i.test((err as Error)?.message ?? "");
}

async function ignoring(match: (err: Error) => boolean, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!match(err as Error)) throw err;
  }
}

/** Attaches the broker to the room's network, creating the network first.
 * Both steps are idempotent; "already exists/connected" is a no-op. */
async function ensureRoomNetwork(name: string): Promise<void> {
  await ignoring(alreadyThere, () => exec("docker", ["network", "create", roomNetworkName(name)]));
  try {
    await exec("docker", ["network", "connect", roomNetworkName(name), BROKER_CONTAINER_NAME]);
  } catch (err) {
    // "already connected" = re-provision after a partial failure. The broker
    // container missing is a test/CLI-only situation (in compose it is us) —
    // warn and go on rather than fail the room, since the lazy re-attach in
    // makeComposeWorkspace will retry it before the first HTTP call anyway.
    if (alreadyThere(err) || brokerContainerMissing(err)) {
      console.warn(`[docker] broker network attach for ${name} skipped: ${(err as Error).message}`);
      return;
    }
    throw err;
  }
}

/** Best-effort lazy reconciliation primitive (see module header): re-creates
 * the network if absent and re-attaches the broker, ignoring every error —
 * the subsequent HTTP retry reports the real problem if this didn't help. */
export async function ensureBrokerConnected(name: string): Promise<void> {
  try {
    await ensureRoomNetwork(name);
  } catch (err) {
    console.warn(`[docker] lazy network reconciliation for ${name} failed: ${(err as Error)?.message ?? err}`);
  }
}

/** Reads a room's env file, or undefined when it doesn't exist yet. */
async function readRoomEnv(name: string): Promise<Record<string, string> | undefined> {
  try {
    return parseEnvFile(await readFile(roomEnvFilePath(name), "utf8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

/** `docker inspect` of a room container's .State — undefined when gone. */
async function inspectContainerState(name: string): Promise<DockerContainerState | undefined> {
  try {
    const { stdout } = await exec("docker", ["inspect", "--format", "{{json .State}}", name]);
    return JSON.parse(stdout) as DockerContainerState;
  } catch (err) {
    if (notFound(err)) return undefined;
    throw err;
  }
}

/**
 * Idempotent provision — same contract as k8s.provisionRoom:
 *  a. the room's env file (0600) holds the runner's env; if it already exists
 *     its password is REUSED, never regenerated — a still-running runner has
 *     the old password baked in, and rewriting it would 401 every session
 *     (mirror of the k8s Secret read-back rule);
 *  b. per-room network, created if absent;
 *  c. broker attached to it (no-op when already attached);
 *  d. the container itself: left alone when Running, removed and recreated
 *     when it exists but isn't (Exited/Dead/Created — `--restart no` means a
 *     dead runner stays dead, same as restartPolicy: Never);
 * resolving to the room's (pre-existing or fresh) opencode server password.
 */
export async function provisionRoom(name: string, env: RoomEnv, agentRules?: string): Promise<string> {
  const existing = await readRoomEnv(name);
  const serverPassword = existing?.OPENCODE_SERVER_PASSWORD ?? randomBytes(16).toString("hex");
  if (!existing) {
    await mkdir(path.dirname(roomEnvFilePath(name)), { recursive: true });
    await writeFile(
      roomEnvFilePath(name),
      envFileContent({
        REPO: env.repo,
        GH_TOKEN: env.token,
        OPENCODE_SERVER_PASSWORD: serverPassword,
        OPENROUTER_API_KEY: env.openrouterKey,
        GIT_USER_NAME: env.gitAuthorName,
        GIT_USER_EMAIL: env.gitAuthorEmail,
      }),
      { mode: 0o600 },
    );
  }

  await ensureRoomNetwork(name);

  const state = await inspectContainerState(name);
  if (state?.Running) return serverPassword;
  if (state) {
    // Exists but not usable (exited/dead/paused/created-but-never-started):
    // `--restart no` keeps a crashed runner dead forever — same choice as the
    // k8s driver's restartPolicy: Never — so drop it and recreate fresh.
    await exec("docker", ["rm", "-f", name]);
  }
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--network",
    roomNetworkName(name),
    "--env-file",
    roomEnvFilePath(name),
    "--memory",
    RUNNER_MEM,
    "--cpus",
    RUNNER_CPUS,
    "--restart",
    "no",
    "--label",
    `alveole.room=${name}`,
  ];
  // Multi-line value — rides via -e (see module header), never --env-file.
  if (agentRules) args.push("-e", `AGENT_RULES=${agentRules}`);
  args.push(RUNNER_IMAGE);
  await exec("docker", args);

  return serverPassword;
}

/** Base URL of a room's opencode server: the room container's name resolves
 * via Docker's embedded DNS on its per-room network (the broker is attached
 * to it by provision/lazy reconciliation). */
export function roomServerUrl(name: string): string {
  return `http://${name}:${OPENCODE_PORT}`;
}

export async function teardownRoom(name: string): Promise<void> {
  await ignoring(notFound, () => exec("docker", ["rm", "-f", name]));
  // disconnect is pure hygiene (the network is about to go away) — never fail
  // the teardown over it.
  await ignoring(() => true, () => exec("docker", ["network", "disconnect", roomNetworkName(name), BROKER_CONTAINER_NAME]));
  await ignoring(notFound, () => exec("docker", ["network", "rm", roomNetworkName(name)]));
  await rm(roomEnvFilePath(name), { force: true });
}

/** Reads the room's opencode server password back from its env file. */
export async function getRoomServerPassword(name: string): Promise<string> {
  const env = await readRoomEnv(name);
  if (!env?.OPENCODE_SERVER_PASSWORD) {
    throw new Error(`no OPENCODE_SERVER_PASSWORD in ${roomEnvFilePath(name)}`);
  }
  return env.OPENCODE_SERVER_PASSWORD;
}

export async function readRoomPodState(name: string): Promise<RoomPodState> {
  return inspectStateToRoomPodState(await inspectContainerState(name));
}

/**
 * Poll docker inspect every 2s until State.Running. Exits early — with the
 * inspect-reported reason — when the container already Exited or Docker
 * surfaced an error string (the compose equivalent of k8s.ts's
 * FATAL_WAIT_REASONS), so a bad image/entrypoint fails the wait in seconds
 * instead of burning the whole deadline.
 */
export async function waitForRunning(name: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await inspectContainerState(name);
    if (!state) throw new Error(`room container ${name} disappeared while waiting for it to run`);
    if (state.Running) return;
    if (state.Status === "exited" || state.Status === "dead" || state.Error) {
      const reason = state.Error || `exit code ${state.ExitCode ?? "?"}${state.OOMKilled ? " (OOMKilled)" : ""}`;
      throw new Error(`room container ${name} cannot start: ${reason}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`room container ${name} did not become Running within ${timeoutMs}ms`);
}
