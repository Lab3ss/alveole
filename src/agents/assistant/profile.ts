/**
 * The assistant profile — what makes the opencode engine a general-purpose
 * *assistant*: no onboarding (the first mention provisions the workspace), no
 * repo or git, an empty disposable runner, the assistant persona. Several Matrix
 * bots share this profile and differ only in model and account. Everything else
 * (turns, approvals, guardrails, provisioning, `/model`) is the engine's.
 */
import { Effect } from "effect";
import type { Profile } from "../../harness/opencode/profile.ts";
import type { AssistantSettings } from "./config.ts";
import type { Room } from "./registry.ts";
import { assistantRules, DEFAULT_PERSONA } from "./rules.ts";

export const assistantProfile = (settings: AssistantSettings): Profile<Room> => ({
  defaultMention: "@assistant",
  runnerImage: settings.runnerImage,
  runnerEnv: () => ({}), // nothing room-specific: no repo, no credentials
  rules: (channel) => assistantRules(channel, settings.systemPrompt ?? DEFAULT_PERSONA),
  podWaitText: "⏳ waiting for the workspace to start…",
  setupText: () => "Setting up your workspace…",
  teardownEvent: (reason) => ({
    type: "info",
    text: `🛑 Stopped (${reason}). The workspace and conversation context were reset — send a message to start fresh.`,
  }),

  /** Bot just joined: say how to talk to it. No-op for a known conversation
   * (the adapter can fire this both on a fresh join and at startup). */
  greet: (conversationId, ctx) =>
    Effect.gen(function* () {
      if (ctx.registry.get(conversationId)) return;
      ctx.registry.create(conversationId);
      yield* ctx.send(conversationId, {
        type: "info",
        text:
          `Hi! Mention me (${ctx.mention}) to ask anything — I can fetch web pages too. ` +
          `I only act when mentioned. My workspace is disposable: after ${settings.idleHours}h idle it resets, ` +
          "and I forget the conversation.",
      });
    }),
});
