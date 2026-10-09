/**
 * The workspace/infra domain (per-room k8s resources + the room's opencode
 * server) behind an Effect service. Wraps the promise/sync modules
 * (src/k8s.ts, src/opencode.ts) at this seam — everything below stays plain
 * TypeScript; everything above (orchestrator) speaks Effect.
 *
 * Error discipline: every method's error channel is a `Failure<Code>` — a
 * stable literal `code` per failure mode (so callers still switch on exact
 * causes) paired with `details`, the raw cause's message, so a chat room can
 * show what actually happened. The raw cause itself (HTTP status, errno,
 * stack) is logged in full at this seam once; only its message travels
 * further. Nothing throws across this boundary.
 *
 * The LLM credential (OPENROUTER_API_KEY) is infra-side: the orchestrator
 * never sees it, it's injected here at wiring time and copied into each
 * room's Secret at provision time.
 */
import { Context, Effect, Layer } from "effect";
import * as docker from "./docker.ts";
import * as k8s from "./k8s.ts";
import * as opencode from "./opencode.ts";
import { describeError } from "../../platform/util.ts";

export type { RoomPodState, RoomEnv } from "./k8s.ts";
export type { SessionUsage, PermissionRequest, ToolProgress, SessionError, SessionCostUpdate, QuestionAsk } from "./opencode.ts";

/** Stable failure codes for the workspace seam. Raw causes are logged where
 * they happen (see `failing`), never propagated. */
export type WorkspaceError =
  | "provision-failed" // k8s create of Secret/Pod/Service failed (non-conflict)
  | "pod-wait-failed" // pod didn't reach Running (timeout, ImagePullBackOff, Failed phase…)
  | "pod-read-failed" // the pod GET itself failed (API/rbac/network — not 404, which is a state)
  | "teardown-failed" // deleting Pod/Service/Secret failed on something non-404
  | "secret-read-failed" // couldn't read back the room's server password
  | "session-create-failed" // opencode POST /session kept failing
  | "probe-failed" // connectivity probe kept failing (wedged connection)
  | "messages-fetch-failed" // GET /session/:id/message failed (reply retrieval after a turn)
  | "session-abort-failed" // couldn't stop a turn the core gave up on
  | "usage-fetch-failed" // GET /session/:id failed
  | "permission-respond-failed" // POSTing an approval decision failed
  | "question-respond-failed" // POSTing a question answer failed
  | "shell-run-failed" // POSTing a shell command to the runner failed
  | "runner-version-mismatch" // the runner's opencode version != the one this client's contract targets
  | "watch-failed"; // SSE event stream couldn't be opened

/** A workspace failure: the stable `code` (for callers to switch on) plus
 * `details` — the raw cause's message, safe to surface since only this
 * broker's own operator talks to it right now. */
export type Failure<Code extends WorkspaceError = WorkspaceError> = { readonly code: Code; readonly details: string };

/** Callbacks out of the room's SSE event stream (runs outside Effect land). */
export type WatchHandlers = {
  onPermission: (req: opencode.PermissionRequest) => void;
  onProgress: (progress: opencode.ToolProgress) => void;
  onSessionError: (err: opencode.SessionError) => void;
  onCostUpdate: (update: opencode.SessionCostUpdate) => void;
  onCompacted: (sessionId: string) => void;
  onIdle: (sessionId: string) => void;
  onQuestion: (ask: opencode.QuestionAsk) => void;
  onError: (err: unknown) => void;
};

export interface WorkspaceService {
  /** DNS-safe pod/secret/service name for a conversation (label is cosmetic). */
  readonly resourceName: (conversationId: string, label?: string) => string;
  /** In-cluster base URL of the room's opencode server. */
  readonly serverUrl: (resourceName: string) => string;
  /** Idempotent provision (Secret+Pod+Service); resolves to the server password. */
  readonly provision: (
    resourceName: string,
    project: { repo: string; token: string; gitAuthorName?: string; gitAuthorEmail?: string },
    agentRules?: string,
  ) => Effect.Effect<string, Failure<"provision-failed" | "secret-read-failed">>;
  readonly waitForRunning: (resourceName: string) => Effect.Effect<void, Failure<"pod-wait-failed">>;
  readonly readPodState: (resourceName: string) => Effect.Effect<k8s.RoomPodState, Failure<"pod-read-failed">>;
  readonly teardown: (resourceName: string) => Effect.Effect<void, Failure<"teardown-failed">>;
  /** Reads the room's opencode server password from its live Secret. */
  readonly serverPassword: (resourceName: string) => Effect.Effect<string, Failure<"secret-read-failed">>;
  /** Creates the opencode session, retrying until the HTTP server is listening. */
  readonly createSession: (
    baseUrl: string,
    password: string,
  ) => Effect.Effect<string, Failure<"session-create-failed" | "runner-version-mismatch">>;
  /** Bounded connectivity probe, retried — fails fast on a wedged connection. */
  readonly probe: (baseUrl: string, password: string) => Effect.Effect<void, Failure<"probe-failed">>;
  readonly sendPrompt: (
    baseUrl: string,
    password: string,
    sessionId: string,
    text: string,
    model: string | undefined,
    onDone: (err: string | undefined) => void,
  ) => Effect.Effect<void>;
  /** Pulls a finished turn's user-facing result from the message list:
 * { text } on success, { error } when the turn was rejected (e.g. context
 * too large), { text: "" } when the turn produced no text at all. */
  readonly turnResult: (
    baseUrl: string,
    password: string,
    sessionId: string,
  ) => Effect.Effect<{ text: string; error?: string }, Failure<"messages-fetch-failed">>;
  /** Stops a turn that the core gave up on, so it can't queue future ones. */
  readonly abort: (baseUrl: string, password: string, sessionId: string) => Effect.Effect<void, Failure<"session-abort-failed">>;
  readonly usage: (
    baseUrl: string,
    password: string,
    sessionId: string,
  ) => Effect.Effect<opencode.SessionUsage, Failure<"usage-fetch-failed">>;
  readonly respondPermission: (
    baseUrl: string,
    password: string,
    sessionId: string,
    permissionId: string,
    approved: boolean,
  ) => Effect.Effect<void, Failure<"permission-respond-failed">>;
  readonly answerQuestion: (
    baseUrl: string,
    password: string,
    sessionId: string,
    requestId: string,
    answers: string[][],
  ) => Effect.Effect<void, Failure<"question-respond-failed">>;
  /** Runs one shell command inside the room's workspace via opencode's
   * `/session/:id/shell` (used by `/git-name` / `/git-email` to rewrite the
   * live runner's git config without re-provisioning). */
  readonly runShell: (
    baseUrl: string,
    password: string,
    sessionId: string,
    command: string,
  ) => Effect.Effect<void, Failure<"shell-run-failed">>;
  /** Opens the SSE stream; resolves to a stop function. Handlers run detached. */
  readonly watch: (
    baseUrl: string,
    password: string,
    handlers: WatchHandlers,
  ) => Effect.Effect<() => void, Failure<"watch-failed">>;
}

export class Workspace extends Context.Tag("alveole/Workspace")<Workspace, WorkspaceService>() {}

/**
 * The container is Running before opencode's HTTP server inside it is actually listening.
 * Each attempt gets its own short-lived connection (callers pass a short AbortSignal timeout)
 * so a single wedged TCP handshake (e.g. a stale conntrack entry) can't stall the whole retry
 * loop — logged so `kubectl logs` shows why it's still "connecting" instead of nothing at all.
 */
function retryUntilReady<T>(fn: () => Promise<T>, attempts = 10, delayMs = 2000): Promise<T> {
  let lastErr: unknown;
  return (async () => {
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        console.warn(`[retryUntilReady] attempt ${i + 1}/${attempts} failed: ${err?.message ?? err}`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  })();
}

/** Wraps a promise call into an Effect whose failure is `{ code, details }`.
 * The raw cause is logged here in full once; `details` (its message) rides
 * along in the failure so it can reach the chat room too. */
const failing = <A, E extends WorkspaceError>(code: E, run: () => Promise<A>): Effect.Effect<A, Failure<E>> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => {
      const details = describeError(cause);
      console.error(`[workspace] ${code}: ${details}`);
      return { code, details };
    },
  });

/**
 * Refuses a runner whose opencode version differs from the one this broker's
 * HTTP client was written against (EXPECTED_OPENCODE_VERSION). Which version a
 * room actually runs is chosen per-deployment by RUNNER_IMAGE (and defaults
 * differ by backend: k8s pulls a published ghcr tag, compose builds a local
 * tag), so without this the interface contract could silently drift between
 * deployments — and a moved route/event does not error, it falls through to
 * the web UI (200 text/html) or is simply never seen. Checked once per session
 * create (provision/recovery only, not per message), so the cost is one GET.
 */
const assertRunnerVersion = (baseUrl: string, password: string): Effect.Effect<void, Failure<"runner-version-mismatch">> =>
  failing("runner-version-mismatch", async () => {
    const actual = await opencode.getServerVersion(baseUrl, password);
    if (actual !== opencode.EXPECTED_OPENCODE_VERSION) {
      throw new Error(
        `runner runs opencode ${actual}, broker expects ${opencode.EXPECTED_OPENCODE_VERSION} — the HTTP contract can differ between versions; set RUNNER_IMAGE to a tag built with opencode ${opencode.EXPECTED_OPENCODE_VERSION}`,
      );
    }
  });

/**
 * The HTTP-only methods shared by both drivers: createSession/probe/sendPrompt/
 * watch/... only ever speak to the room's opencode server over HTTP, so they
 * are byte-for-byte identical whether the room is a k8s pod or a compose
 * container. Only the infra half (resource naming, provision, waits, state,
 * teardown, password) is driver-specific.
 */
const httpMethods = () => ({
  createSession: (baseUrl: string, password: string) =>
    Effect.flatMap(
      failing("session-create-failed", () =>
        // 90 × 2s ≈ 3 min: the container is "Running" while entrypoint.sh is
        // still cloning the repo — serve only exec's AFTER the clone, and a
        // slow one easily outlives the previous 10×2s budget, surfacing as
        // session-create-failed/ECONNREFUSED on a pod that was fine.
        retryUntilReady(
          () => opencode.createSession(baseUrl, password, AbortSignal.timeout(10_000)),
          90,
          2000,
        ),
      ),
      (id) => Effect.as(assertRunnerVersion(baseUrl, password), id),
    ),
  probe: (baseUrl: string, password: string) => failing("probe-failed", () => retryUntilReady(() => opencode.probeConnection(baseUrl, password))),
  sendPrompt: (baseUrl: string, password: string, sessionId: string, text: string, model: string | undefined, onDone: (err: string | undefined) => void) =>
    Effect.sync(() => opencode.sendPrompt(baseUrl, password, sessionId, text, model, onDone)),
  turnResult: (baseUrl: string, password: string, sessionId: string) =>
    Effect.map(
      failing("messages-fetch-failed", () => opencode.getMessages(baseUrl, password, sessionId)),
      (messages) => opencode.extractTurnResult(messages),
    ),
  abort: (baseUrl: string, password: string, sessionId: string) => failing("session-abort-failed", () => opencode.abortSession(baseUrl, password, sessionId)),
  usage: (baseUrl: string, password: string, sessionId: string) => failing("usage-fetch-failed", () => opencode.getSessionUsage(baseUrl, password, sessionId)),
  respondPermission: (baseUrl: string, password: string, sessionId: string, permissionId: string, approved: boolean) =>
    failing("permission-respond-failed", () => opencode.respondPermission(baseUrl, password, sessionId, permissionId, approved)),
  answerQuestion: (baseUrl: string, password: string, sessionId: string, requestId: string, answers: string[][]) =>
    failing("question-respond-failed", () => opencode.answerQuestion(baseUrl, password, sessionId, requestId, answers)),
  runShell: (baseUrl: string, password: string, sessionId: string, command: string) =>
    failing("shell-run-failed", () => opencode.runShell(baseUrl, password, sessionId, command)),
  watch: (baseUrl: string, password: string, handlers: WatchHandlers) =>
    failing("watch-failed", () =>
      opencode.watchPermissions(
        baseUrl,
        password,
        handlers.onPermission,
        handlers.onProgress,
        handlers.onSessionError,
        handlers.onCostUpdate,
        handlers.onCompacted,
        handlers.onIdle,
        handlers.onQuestion,
        handlers.onError,
      ),
    ),
});

const makeK8sWorkspace = (config: { openrouterKey: string }): WorkspaceService => ({
  ...httpMethods(),
  resourceName: k8s.roomResourceName,
  serverUrl: k8s.roomServerUrl,

  provision: (name, project, agentRules) =>
    failing("provision-failed", () =>
      k8s.provisionRoom(
        name,
        { repo: project.repo, token: project.token, openrouterKey: config.openrouterKey, gitAuthorName: project.gitAuthorName, gitAuthorEmail: project.gitAuthorEmail },
        agentRules,
      ),
    ),
  waitForRunning: (name) => failing("pod-wait-failed", () => k8s.waitForRunning(name)),
  readPodState: (name) => failing("pod-read-failed", () => k8s.readRoomPodState(name)),
  teardown: (name) => failing("teardown-failed", () => k8s.teardownRoom(name)),
  serverPassword: (name) => failing("secret-read-failed", () => k8s.getRoomServerPassword(name)),
});

/**
 * Compose driver (WORKSPACE_BACKEND=compose): same WorkspaceService contract,
 * src/docker.ts underneath. Lifecycle semantics (idle sweep, watchdogs,
 * self-heal, re-provisioning) are the orchestrator's and are untouched — the
 * only difference is which infrastructure the infra half talks to.
 *
 * Broker-restart reconciliation is lazy (see src/docker.ts's header for the
 * full rationale): after a broker restart, live room containers keep running
 * but the broker has lost its membership in their per-room networks, so every
 * HTTP call would ECONNREFUSED until it re-attaches. Rather than an intrusive
 * startup sweep through the orchestrator, the re-attach happens lazily:
 *  - provisionRoom re-runs the attach every time (idempotent);
 *  - serverPassword — the FIRST workspace call on every recovery path
 *    (ensureProvisioned's already-running branch, /usage, /stop) — best-effort
 *    re-attaches before reading the env file, so the watch/session recovery
 *    below it finds the network healthy;
 *  - createSession additionally re-attaches once on a connection-refused-type
 *    failure as belt-and-suspenders for anything the first two missed.
 */
const makeComposeWorkspace = (config: { openrouterKey: string }): WorkspaceService => {
  /** Room resource name a room's baseUrl points at (docker DNS name = container name). */
  const roomNameFromUrl = (baseUrl: string): string => new URL(baseUrl).hostname;
  /** Connection-establishment failures — the room container may be perfectly
   * healthy and the broker just not (yet) attached to its network. */
  const isConnectionError = (err: unknown): boolean =>
    /(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)/.test(describeError(err));

  return {
    ...httpMethods(),
    resourceName: docker.roomResourceName,
    serverUrl: docker.roomServerUrl,

    provision: (name, project, agentRules) =>
      failing("provision-failed", () =>
        docker.provisionRoom(
          name,
          { repo: project.repo, token: project.token, openrouterKey: config.openrouterKey, gitAuthorName: project.gitAuthorName, gitAuthorEmail: project.gitAuthorEmail },
          agentRules,
        ),
      ),
    waitForRunning: (name) => failing("pod-wait-failed", () => docker.waitForRunning(name)),
    readPodState: (name) => failing("pod-read-failed", () => docker.readRoomPodState(name)),
    teardown: (name) => failing("teardown-failed", () => docker.teardownRoom(name)),
    serverPassword: (name) =>
      failing("secret-read-failed", async () => {
        await docker.ensureBrokerConnected(name); // lazy reconciliation — never fails the read
        return docker.getRoomServerPassword(name);
      }),
    // Identical to the shared one, except a connection-refused-shaped failure
    // gets one lazy re-attach + a second retry budget before surfacing.
    createSession: (baseUrl, password) =>
      Effect.flatMap(
        failing("session-create-failed", async () => {
          try {
            return await retryUntilReady(() => opencode.createSession(baseUrl, password, AbortSignal.timeout(10_000)), 90, 2000);
          } catch (err) {
            if (!isConnectionError(err)) throw err;
            console.warn(`[workspace] createSession to ${baseUrl} failed on a connection error — re-attaching broker to the room network and retrying`);
            await docker.ensureBrokerConnected(roomNameFromUrl(baseUrl));
            return await retryUntilReady(() => opencode.createSession(baseUrl, password, AbortSignal.timeout(10_000)), 90, 2000);
          }
        }),
        (id) => Effect.as(assertRunnerVersion(baseUrl, password), id),
      ),
  };
};

export const WorkspaceLive = (config: { openrouterKey: string }) => {
  const backend = process.env.WORKSPACE_BACKEND ?? "k8s";
  const make = backend === "compose" ? makeComposeWorkspace : makeK8sWorkspace;
  return Layer.effect(Workspace, Effect.sync(() => make(config)));
};
