/**
 * HTTP client for one room's `opencode serve` instance (see runner/entrypoint.sh).
 * Basic-auth protected with a per-room random password (see src/k8s.ts) so
 * nothing else in the coding-agent-rooms namespace can reach another room's
 * server even over the cluster network.
 */
import { Agent, fetch as undiciFetch } from "undici";
import { describeError } from "./util.ts";

// Node's *global* fetch defaults to a 5-minute socket timeout (undici's
// Agent default headersTimeout/bodyTimeout), which a real multi-step coding
// task (many tool calls, edits, test runs on /session/:id/message, a single
// blocking request for the whole turn) can easily exceed. A custom Agent
// can't be passed as `dispatcher` to the *global* fetch, though — Node's
// built-in fetch validates it against its own internal undici instance, and
// an Agent constructed from the separately-installed `undici` npm package
// fails that check immediately (UND_ERR_INVALID_ARG), before ever making a
// request. Using undici's own `fetch` export here (paired with an Agent
// from that same package instance) avoids the cross-instance mismatch.
// connectTimeout is separate from headersTimeout/bodyTimeout — it only bounds the TCP
// handshake, not the wait for opencode's response — so a stuck connection (e.g. a stale
// conntrack entry routing the SYN into a black hole) fails fast and lets the caller retry
// on a fresh socket, instead of silently tying up the turn budget for nothing.
// headersTimeout/bodyTimeout are set far beyond anything the orchestrator's own turn
// guardrails (inactivity watchdog, duration cap, session-cost cap) would ever let run:
// the turn's real limits live there — this is only here so the socket itself can't be
// the thing that decides when a legitimate long turn dies.
const longRunningDispatcher = new Agent({ connectTimeout: 10_000, headersTimeout: 86_400_000, bodyTimeout: 86_400_000 });

function authHeader(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

// undici's fetch returns undici's own Response type (its stream types don't
// line up with the DOM `Response` globals) — derive it instead of importing,
// so the fetch/agent pair always stays type-consistent.
type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;

async function req<T>(baseUrl: string, password: string, path: string, init?: RequestInit): Promise<T> {
  const attempt = () =>
    undiciFetch(baseUrl + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: authHeader(password), ...(init?.headers ?? {}) },
      dispatcher: longRunningDispatcher,
    } as Parameters<typeof undiciFetch>[1]);
  let res: UndiciResponse;
  try {
    res = await attempt();
  } catch (err: any) {
    // A stuck TCP handshake (e.g. a stale conntrack entry) never reaches the server, so
    // retrying once on a fresh connection is always safe here — unlike a timeout after the
    // request was already sent, which might have side effects and must surface as an error.
    if (err?.code !== "UND_ERR_CONNECT_TIMEOUT") throw err;
    console.warn(`[opencode] connect timeout on ${path}, retrying once on a fresh connection`);
    res = await attempt();
  }
  if (!res.ok) throw new Error(`opencode ${path} -> ${res.status} ${await res.text().catch(() => "")}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export async function createSession(baseUrl: string, password: string, signal?: AbortSignal): Promise<string> {
  const session = await req<{ id: string }>(baseUrl, password, "/session", { method: "POST", body: "{}", signal });
  return session.id;
}

/**
 * Cheap, side-effect-free connectivity check. `sendPrompt` can legitimately
 * take as long as the whole turn (which may pause on a human approval gate),
 * so it can't carry a short AbortSignal itself — but a wedged TCP handshake
 * (stale conntrack entry) looks identical to a slow real turn from the caller's
 * side, so the only way to fail fast on the former without cutting off the latter is to probe
 * first, on a bounded timeout, before committing to the long call.
 */
export async function probeConnection(baseUrl: string, password: string): Promise<void> {
  await req(baseUrl, password, "/session/status", { signal: AbortSignal.timeout(10_000) });
}

/** A raw message as returned by GET /session/:id/message. Kept loose: only the
 * fields below are relied on (see extractReplyText), anything else passes through. */
export type RawMessage = { info?: any; parts?: Array<any> };

/**
 * Fires a prompt at the room's opencode server and returns immediately — the
 * turn may run for hours (multi-step work, or paused on an approval gate
 * waiting for a human), so nothing must impose a deadline on it.
 *
 * `onDone` is called exactly once, later:
 * - `onDone(undefined)` when the POST resolves (opencode answers only at turn
 *   end) — treated by the orchestrator as a turn-completion signal, redundant
 *   with the SSE idle event in case the stream dropped;
 * - `onDone(details)` on early failure (pod gone, connection refused) or a
 *   non-2xx at turn end.
 *
 * Completion itself is detected by the orchestrator via the SSE stream; the
 * reply text is fetched afterwards with getMessages — the POST response is
 * deliberately not parsed into a result.
 */
export function sendPrompt(
  baseUrl: string,
  password: string,
  sessionId: string,
  text: string,
  model: string | undefined,
  onDone: (err: string | undefined) => void,
): void {
  const body: Record<string, unknown> = { parts: [{ type: "text", text }] };
  // The API wants { providerID, modelID }, not a bare string. Every room only
  // has an OPENROUTER_API_KEY, so the provider is always "openrouter"; the
  // user-supplied model (e.g. "google/gemini-3.8-flash:batch") is the modelID
  // OpenRouter itself expects.
  if (model) body.model = { providerID: "openrouter", modelID: model };
  const attempt = () =>
    undiciFetch(baseUrl + `/session/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader(password) },
      body: JSON.stringify(body),
      dispatcher: longRunningDispatcher,
    } as Parameters<typeof undiciFetch>[1]);
  const settle = async (res: UndiciResponse) => {
    if (!res.ok) onDone(`opencode /session/${sessionId}/message -> ${res.status} ${await res.text().catch(() => "")}`);
    else {
      await res.json().catch(() => undefined); // drain the body, free the socket
      onDone(undefined);
    }
  };
  attempt().then(settle).catch((err: any) => {
    // Same rationale as req(): a failed TCP handshake never reached the server,
    // so retrying once on a fresh connection is side-effect-free.
    if (err?.code !== "UND_ERR_CONNECT_TIMEOUT") return onDone(describeError(err));
    console.warn(`[opencode] connect timeout sending prompt, retrying once on a fresh connection`);
    attempt().then(settle).catch((err2: any) => onDone(describeError(err2)));
  });
}

/** Lists a session's messages, oldest first — used to fetch the turn's reply
 * after completion. This endpoint answers immediately; no long-running timeout
 * concerns. */
export async function getMessages(baseUrl: string, password: string, sessionId: string): Promise<RawMessage[]> {
  const res = await req<RawMessage[]>(baseUrl, password, `/session/${sessionId}/message`);
  return Array.isArray(res) ? res : [];
}

/**
 * Extracts the user-facing result of a just-finished turn from the message list.
 * opencode emits one assistant message per step (tool-calls included), all
 * sharing the same parentID — the reply is the LAST assistant message of the
 * turn (its finish reason is "stop"); intermediate ones are narration around
 * tool calls. Falls back to the last assistant message overall when the turn's
 * user message can't be located (e.g. after compaction edge cases).
 *
 * A REJECTED turn (e.g. context too large for the model) surfaces as a normal
 * end-of-turn with the real failure on the assistant message's info.error and
 * no text — returning it as `error` (instead of an empty `text`) keeps an
 * actionable message from hiding behind a blank reply.
 */
export function extractTurnResult(messages: RawMessage[]): { text: string; error?: string } {
  const lastUser = [...messages].reverse().find((m) => m.info?.role === "user");
  const assistants = messages.filter((m) => m.info?.role === "assistant");
  const turnReply =
    (lastUser ? [...assistants].reverse().find((m) => m.info?.parentID === lastUser.info?.id) : undefined) ??
    assistants.at(-1);
  const error = turnReply?.info?.error
    ? (turnReply.info.error.data?.message ?? turnReply.info.error.name ?? "unknown error")
    : undefined;
  const text = (turnReply?.parts ?? [])
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n")
    .trim();
  return error ? { text, error } : { text };
}

/**
 * Stops any ongoing AI processing/command execution for a session. Must be called when the
 * orchestrator gives up on a turn (watchdog, duration/cost cap) — opencode has no
 * visibility into "the broker stopped waiting", so without this the turn keeps running
 * server-side forever, and since a session processes one turn at a time, every subsequent
 * message on that session queues silently behind it (zero CPU, zero network — just stuck
 * waiting its turn) instead of erroring.
 */
export async function abortSession(baseUrl: string, password: string, sessionId: string): Promise<void> {
  await req(baseUrl, password, `/session/${sessionId}/abort`, { method: "POST" });
}

export type SessionUsage = {
  cost?: number;
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  compactedAt?: number;
};

// Some providers/models routed through OpenRouter don't report cost (e.g. free-tier or
// BYOK routes), so callers must treat every field here as possibly absent rather than crash.
export async function getSessionUsage(baseUrl: string, password: string, sessionId: string): Promise<SessionUsage> {
  const session = await req<any>(baseUrl, password, `/session/${sessionId}`);
  return { cost: session?.cost, tokens: session?.tokens, compactedAt: session?.time?.compacting };
}

/**
 * Answers a permission ask. Wire vocabulary verified against the pod's
 * opencode (runner 0.2.2): `response` is "once" | "always" | "reject" — an
 * older "allow"/"deny" body gets a 400 and the turn hangs on the gate
 * forever. Approval maps to "once" (this ask only; the room prompt is a
 * boolean yes/no, no "always this session" affordance yet).
 */
export async function respondPermission(
  baseUrl: string,
  password: string,
  sessionId: string,
  permissionId: string,
  approved: boolean,
): Promise<void> {
  await req(baseUrl, password, `/session/${sessionId}/permissions/${permissionId}`, {
    method: "POST",
    body: JSON.stringify({ response: approved ? "once" : "reject" }),
  });
}

export type PermissionRequest = { sessionId: string; permissionId: string; description: string };
export type ToolProgress = { sessionId: string; title: string };
export type SessionError = { sessionId?: string; message: string };
export type SessionCostUpdate = { sessionId: string; cost?: number };

export type SseHandlers = {
  onPermission: (req: PermissionRequest) => void;
  onProgress: (progress: ToolProgress) => void;
  onSessionError: (err: SessionError) => void;
  onCostUpdate: (update: SessionCostUpdate) => void;
  onCompacted: (sessionId: string) => void;
  /** The session went idle: turn finished (session.idle, or session.status
   * transitioning to idle). Fires for ANY session of the pod (subagents have
   * their own sessionIDs) — callers filter. */
  onIdle: (sessionId: string) => void;
};

/**
 * Maps one raw `/global/event` SSE payload onto the typed handlers. Kept as a
 * separate exported function so event-shape handling is unit-testable without
 * a live opencode server.
 *
 * Wire shapes verified against opencode v1.18.32's generated SDK types
 * (packages/sdk/js/src/gen/types.gen.ts at that tag):
 * - `/global/event` streams `GlobalEvent = { directory, payload: Event }` —
 *   every event is nested under `payload`, so dispatch unwraps it first.
 * - Permission asks arrive as `permission.updated` with the request id in
 *   `properties.id` (NOT `permissionID` — that field only exists on
 *   `permission.replied`, the broker's own answer, which must not re-ask).
 * - Tool progress is `message.part.updated` with
 *   `properties.part.{type:"tool", state:{status,title}}`; state.status is
 *   "pending"|"running"|"completed"|"error" — only "running" relays (a pending
 *   part has no title yet, a completed one already showed).
 * - `session.updated` carries the full session info incl. live `cost`.
 * Anything else is left unmatched and logged once per type (see below) so a
 * future opencode bump that renames fields is immediately visible instead of
 * silently deafening the room — the failure mode this file shipped with and
 * the one that produced 30-minute "task failed" turns waiting on approvals
 * nobody ever saw.
 */
export function dispatchEvent(evt: any, handlers: SseHandlers): boolean {
  // /global/event wraps each event in { directory, payload } — unwrap, but
  // tolerate a bare { type, properties } (project-scoped /event, tests).
  const inner = evt?.payload?.type ? evt.payload : evt;
  if (!inner || typeof inner !== "object") return false;
  const props = inner.properties ?? inner;
  if (inner.type === "permission.updated" || (typeof inner.type === "string" && inner.type.startsWith("permission.") && inner.type !== "permission.replied")) {
    const id = props.id ?? props.permissionID;
    if (id) {
      handlers.onPermission({
        sessionId: props.sessionID,
        permissionId: id,
        description: props.title ?? props.metadata?.command ?? props.permission ?? props.type ?? JSON.stringify(props).slice(0, 200),
      });
      return true;
    }
  } else if (inner.type === "message.part.updated" && props.part?.type === "tool" && props.part.state?.status === "running") {
    handlers.onProgress({
      sessionId: props.part.sessionID,
      title: props.part.state.title ?? props.part.tool,
    });
    return true;
  } else if (inner.type === "session.error") {
    handlers.onSessionError({ sessionId: props.sessionID, message: props.error?.data?.message ?? props.error?.name ?? JSON.stringify(props.error ?? props).slice(0, 200) });
    return true;
  } else if (inner.type === "session.updated") {
    handlers.onCostUpdate({ sessionId: props.sessionID, cost: props.info?.cost });
    return true;
  } else if (inner.type === "session.compacted") {
    handlers.onCompacted(props.sessionID);
    return true;
  } else if (inner.type === "session.idle" || (inner.type === "session.status" && props.status?.type === "idle")) {
    handlers.onIdle(props.sessionID);
    return true;
  }
  return false;
}

// Unknown/never-matched event types are logged once, not per occurrence: the
// /global/event stream is chatty, but any given unrecognized type either
// appears once (one-shot events) or constantly (streams like text deltas) —
// in both cases one sample line in kubectl logs is all a human needs.
const seenUnmatchedTypes = new Set<string>();

/** Feed one raw SSE `data:` line (already trimmed of its prefix) to dispatchEvent. */
function dispatchDataLine(line: string, handlers: SseHandlers): void {
  let evt: any;
  try {
    evt = JSON.parse(line);
  } catch {
    const key = "<non-json>";
    if (!seenUnmatchedTypes.has(key)) {
      seenUnmatchedTypes.add(key);
      console.warn(`[opencode] unparseable SSE data line (logged once): ${line.slice(0, 200)}`);
    }
    return;
  }
  if (!dispatchEvent(evt, handlers)) {
    const type = typeof evt?.payload?.type === "string" ? evt.payload.type : typeof evt?.type === "string" ? evt.type : "<none>";
    if (!seenUnmatchedTypes.has(type)) {
      seenUnmatchedTypes.add(type);
      console.warn(`[opencode] unmatched SSE event type "${type}" (logged once): ${JSON.stringify(evt).slice(0, 300)}`);
    }
  }
}

const SSE_RETRY_BASE_MS = 1_000;
const SSE_RETRY_MAX_MS = 30_000;

/**
 * Opens the room's SSE event stream and dispatches permission requests,
 * per-tool-call activity (feeds the inactivity watchdog and the broker log —
 * tool progress is deliberately NOT relayed to the room), session errors,
 * live cost updates (for the $-spent alert), and compaction events
 * (context got trimmed).
 *
 * Reconnects forever with capped exponential backoff until the returned stop()
 * is called — opencode's stream drops on any transient network blip, pod
 * restart, or proxy idle timeout, and a dead watcher silently kills the
 * approval flow (opencode waits for a decision that is never relayed, so
 * the turn hangs forever with zero feedback in the room). The broker's
 * startPermissionWatcher() early-returns while a watcher entry exists, so
 * without internal reconnection a single drop would permanently deafen the
 * room.
 *
 * ponytail: events emitted while the stream is down are NOT backfilled —
 * opencode has no Last-Event-ID replay we can rely on, so a permission
 * request landing inside a reconnect gap can still be missed. The reconnect
 * window is seconds, vs the previous behavior of "down forever".
 */
export async function watchPermissions(
  baseUrl: string,
  password: string,
  onPermission: (req: PermissionRequest) => void,
  onProgress: (progress: ToolProgress) => void,
  onSessionError: (err: SessionError) => void,
  onCostUpdate: (update: SessionCostUpdate) => void,
  onCompacted: (sessionId: string) => void,
  onIdle: (sessionId: string) => void,
  onError: (err: unknown) => void,
): Promise<() => void> {
  const controller = new AbortController();
  const handlers: SseHandlers = { onPermission, onProgress, onSessionError, onCostUpdate, onCompacted, onIdle };

  (async () => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      try {
        const res = await undiciFetch(baseUrl + "/global/event", {
          headers: { authorization: authHeader(password) },
          signal: controller.signal,
          dispatcher: longRunningDispatcher,
        } as Parameters<typeof undiciFetch>[1]);
        if (!res.ok || !res.body) throw new Error(`/global/event -> ${res.status}`);
        attempt = 0; // healthy connection — reset backoff
        // Decode manually rather than pipeThrough(TextDecoderStream) — undici's
        // ReadableStream type doesn't line up with the DOM transform-stream types.
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            dispatchDataLine(line.slice(5).trim(), handlers);
          }
        }
        // Server closed the stream cleanly — treat like any other drop and reconnect.
        if (controller.signal.aborted) return;
        onError(new Error("event stream ended; reconnecting"));
      } catch (err) {
        if (controller.signal.aborted) return;
        onError(err);
      }
      const delay = Math.min(SSE_RETRY_MAX_MS, SSE_RETRY_BASE_MS * 2 ** attempt) + Math.random() * 500;
      attempt++;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    }
  })();
  return () => controller.abort();
}
