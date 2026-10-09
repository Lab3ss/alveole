/**
 * The agent seam — what an agent is, and the platform wiring that starts it.
 *
 * An Agent is a self-contained bot: it handles one inbound message, cleans up
 * an abandoned conversation, and greets a freshly joined one. The platform
 * knows nothing else about it. `startAgent` hooks the chat adapter's inbound
 * stream to the agent and owns the total error boundary: a typed failure or an
 * escaped defect becomes a room-visible error event instead of an unhandled
 * rejection, so one bad message can never take the process down.
 */
import { Context, Effect } from "effect";
import { ChatAdapter, type InboundMessage } from "./adapter/types.ts";
import { describeError } from "./util.ts";

/** A stable failure code plus the raw cause's message — what an agent may
 * surface to the room through the platform boundary. */
export type AgentError = { readonly code: string; readonly details: string };

export interface AgentService {
  /** Handles one inbound user message. Every path either succeeds or turns its
   * failure into a room-visible error event; the platform boundary is the last
   * line of defence against defects. */
  readonly handleInbound: (msg: InboundMessage) => Effect.Effect<void, AgentError>;
  /** Nobody but the bot is left in a conversation — purge its resources. */
  readonly abandon: (conversationId: string) => Effect.Effect<void>;
  /** Greet a freshly joined conversation (onboarding opener). */
  readonly greet: (conversationId: string) => Effect.Effect<void>;
  /** Optional background loops the agent needs (e.g. an idle sweep). The
   * platform forks it when the agent starts; omitted by agents with no
   * background work. Never completes. */
  readonly start?: Effect.Effect<never>;
}

export class Agent extends Context.Tag("alveole/Agent")<Agent, AgentService>() {}

/**
 * Wires `agent` to the chat transport and starts it. Fails with the adapter's
 * stable "chat-start-failed" code (the raw cause is already logged by the
 * adapter) — boot should crash on it; there is no broker without a chat
 * transport.
 */
export const startAgent = (agent: AgentService): Effect.Effect<void, "chat-start-failed", ChatAdapter> =>
  Effect.gen(function* () {
    const adapter = yield* ChatAdapter;

    // Agent-specific background loops (idle sweep) run for as long as the
    // broker lives; the platform just owns the fork.
    if (agent.start) yield* Effect.forkDaemon(agent.start);

    const runDetached = (conversationId: string, what: string, effect: Effect.Effect<void>): void => {
      void Effect.runPromise(effect).catch((err) =>
        console.error(`[${conversationId}] ${what}:`, describeError(err)),
      );
    };

    yield* adapter.start(
      (msg) => {
        const fail = (failure: AgentError) =>
          adapter.send(msg.conversationId, { type: "error", text: `failed: ${failure.code} — ${failure.details}` });
        runDetached(
          msg.conversationId,
          "agent failure",
          agent.handleInbound(msg).pipe(
            Effect.catchAll(fail),
            // Total by construction: catchDefect converts a defect thrown by
            // sync infra (e.g. SQLite) into a room-visible event rather than an
            // unhandled rejection.
            Effect.catchAllDefect((defect) =>
              Effect.gen(function* () {
                console.error(`[${msg.conversationId}] internal-defect:`, describeError(defect));
                yield* adapter.send(msg.conversationId, {
                  type: "error",
                  text: "internal-defect (details in broker logs)",
                });
              }),
            ),
          ),
        );
      },
      (conversationId) => runDetached(conversationId, "abandon failure", agent.abandon(conversationId)),
      (conversationId) => runDetached(conversationId, "greet failure", agent.greet(conversationId)),
    );
  });
