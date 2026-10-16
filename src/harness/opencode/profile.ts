/**
 * The Profile contract — what an agent supplies to the opencode engine.
 *
 * The engine (engine.ts) owns everything a pod-backed agent does regardless of
 * its job: the mention gate, busy-lock, `/stop /usage /connect /model`,
 * approvals and questions, turn guardrails, provisioning and self-healing, the
 * idle sweep. A profile is the part that differs per agent: which runner image
 * and env its pod gets, how a fresh room is onboarded (if at all), which extra
 * slash-commands it has, and the persona/texts that name its workspace.
 */
import type { Effect } from "effect";
import type { ChatAdapterService, InboundMessage, OutboundEvent } from "../../platform/adapter/types.ts";
import type { ChannelRules } from "../../platform/channel-rules.ts";
import type { HarnessRoom, RegistryService } from "./registry.ts";

/** What the engine hands a profile hook so it can act without owning engine state. */
export interface ProfileContext<R extends HarnessRoom> {
  readonly adapter: ChatAdapterService;
  readonly registry: RegistryService<R>;
  readonly send: (conversationId: string, event: OutboundEvent) => Effect.Effect<void>;
  /** The bot's own handle for hints ("@coding-agent"), from the channel when it has one. */
  readonly mention: string;
  /** The model a freshly set-up room starts on. */
  readonly defaultModel: string;
  /** Runs one shell command in the room's LIVE runner. False when there is no
   * live runner, a turn is running, or the runner couldn't be reached — the
   * caller then applies the change on the next provision. Never fails. */
  readonly runInRunner: (room: R, command: string) => Effect.Effect<boolean>;
  /** Ends onboarding: announces the setup, provisions the pod, tells the room it's ready. */
  readonly completeOnboarding: (room: R) => Effect.Effect<void>;
}

export interface Profile<R extends HarnessRoom = HarnessRoom> {
  /** Handle shown in prompts when the channel has no mention handle of its own. */
  readonly defaultMention: string;
  /** Runner image for this agent's pods. undefined = the driver's RUNNER_IMAGE default. */
  readonly runnerImage?: string;
  /** Env injected into the room's pod (the engine adds the opencode server
   * password and the OpenRouter key). Undefined values are omitted. */
  readonly runnerEnv: (room: R) => Record<string, string | undefined>;
  /** The AGENT_RULES document, composed from the channel's fragments. */
  readonly rules: (channel: ChannelRules) => string;
  /** Status shown while the pod starts. */
  readonly podWaitText: string;
  /** Status shown when onboarding completes and provisioning begins. */
  readonly setupText: (room: R) => string;
  /** Notice sent after a teardown (`/stop`, idle). */
  readonly teardownEvent: (reason: string, room: R) => OutboundEvent;
  /** When a room has no project yet, `/model` replies with this text. undefined =
   * the engine creates the room on demand and sets the model. */
  readonly noRoomText?: string;
  /** The bot joined a conversation. */
  readonly greet: (conversationId: string, ctx: ProfileContext<R>) => Effect.Effect<void>;
  /** Extra slash-commands, tried after the engine's own. True = handled. */
  readonly command?: (
    input: { readonly roomId: string; readonly body: string },
    ctx: ProfileContext<R>,
  ) => Effect.Effect<boolean>;
  /** Onboarding steps for a room that isn't ready yet. True = the message was consumed. */
  readonly onboard?: (
    input: { readonly room: R; readonly body: string; readonly msg: InboundMessage },
    ctx: ProfileContext<R>,
  ) => Effect.Effect<boolean>;
}
