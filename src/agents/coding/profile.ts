/**
 * The coding profile — what makes the opencode engine a *coding* agent: repo +
 * GitHub PAT onboarding, the `/git-name` / `/git-email` commands, the runner's
 * REPO/GH_TOKEN/git-identity env, and the repo-aware persona and texts.
 * Everything else (turns, approvals, guardrails, provisioning) is the engine's.
 */
import { Effect } from "effect";
import type { Profile, ProfileContext } from "../../harness/opencode/profile.ts";
import * as present from "./present.ts";
import type { Room } from "./registry.ts";
import { codingAgentRules } from "./rules.ts";
import { parseRepo, shellQuote } from "./util.ts";

/** The onboarding opener — sent proactively on join (see greet) and re-sent
 * when a room still at the repo step sends something that isn't a repo. */
const REPO_PROMPT =
  "Let's get this workspace set up in two quick steps:\n\n" +
  "1. Send the repo I should work on — `owner/name` or a GitHub URL.\n" +
  "2. Send a GitHub PAT scoped to that repo — it stays only inside this room's isolated workspace.\n\n" +
  "Let's start with step 1: what repo should I work on?\n\n" +
  "(I only act when you @-mention me — include that in every message you send me.)";

/** Pushes the room's git identity overrides into a LIVE runner by rewriting its
 * global git config — so `/git-name` and `/git-email` take effect without a
 * re-provision (which would drop the session). Returns false when there's no
 * live runner (or a turn is running) and the change will instead be seeded on
 * the next provision. Only overrides what's set; the other field keeps its boot
 * value (from the GitHub token). */
const applyGitIdentity = (room: Room, ctx: ProfileContext<Room>): Effect.Effect<boolean> => {
  const sets: string[] = [];
  if (room.gitAuthorName) sets.push(`git config --global user.name ${shellQuote(room.gitAuthorName)}`);
  if (room.gitAuthorEmail) sets.push(`git config --global user.email ${shellQuote(room.gitAuthorEmail)}`);
  return sets.length ? ctx.runInRunner(room, sets.join(" && ")) : Effect.succeed(false);
};

export const codingProfile: Profile<Room> = {
  defaultMention: "@coding-agent",
  runnerEnv: (room) => ({
    REPO: room.repo!,
    GH_TOKEN: room.token!,
    GIT_USER_NAME: room.gitAuthorName,
    GIT_USER_EMAIL: room.gitAuthorEmail,
  }),
  rules: codingAgentRules,
  podWaitText: "⏳ waiting for pod to start (cloning repo)…",
  setupText: (room) => `Setting up ${room.repo}…`,
  teardownEvent: (reason, room) => present.teardown(reason, room.repo ?? ""),
  noRoomText: "No project set up in this room yet — send a repo first.",

  /** Bot just joined: start onboarding immediately instead of waiting for the
   * user to speak first. No-op if the conversation is already known — an
   * onboarded room, one mid-onboarding, or a repeat join signal (the adapter
   * can fire this both on a fresh join and at startup). */
  greet: (conversationId, ctx) =>
    Effect.gen(function* () {
      if (ctx.registry.get(conversationId)) return;
      ctx.registry.create(conversationId);
      yield* ctx.send(conversationId, { type: "info", text: REPO_PROMPT });
    }),

  command: ({ roomId, body }, ctx) =>
    Effect.gen(function* () {
      if (!/^\/git-(name|email)\b/i.test(body)) return false;
      const isEmail = /^\/git-email\b/i.test(body);
      const label = isEmail ? "email" : "name";
      const field = isEmail ? ("gitAuthorEmail" as const) : ("gitAuthorName" as const);
      const room = ctx.registry.get(roomId);
      const arg = body.replace(/^\/git-(?:name|email)\s*/i, "").trim();
      if (!arg) {
        const current = room?.[field];
        yield* ctx.send(roomId, {
          type: "info",
          text: current
            ? `Git author ${label}: ${current}`
            : `No git author ${label} override set — the workspace derives it from the room's GitHub token.`,
        });
        return true;
      }
      if (!room) {
        yield* ctx.send(roomId, { type: "info", text: "No project set up in this room yet — send a repo first." });
        return true;
      }
      if (isEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(arg)) {
        yield* ctx.send(roomId, { type: "info", text: "That doesn't look like an email address." });
        return true;
      }
      room[field] = arg;
      ctx.registry.save(room);
      const applied = yield* applyGitIdentity(room, ctx);
      yield* ctx.send(roomId, {
        type: "info",
        text:
          `Git author ${label} set to ${arg}. ` +
          (applied ? "Takes effect now." : "Takes effect when the workspace next provisions."),
      });
      return true;
    }),

  onboard: ({ room, body, msg }, ctx) =>
    Effect.gen(function* () {
      if (room.onboarding === "repo") {
        const repo = parseRepo(body);
        if (!repo) {
          yield* ctx.send(room.roomId, { type: "info", text: REPO_PROMPT });
          return true;
        }
        room.repo = repo;
        room.onboarding = "token";
        ctx.registry.save(room);
        yield* ctx.send(room.roomId, {
          type: "info",
          text: `Got it: ${repo}. Now send a GitHub PAT scoped to that repo — it's used only inside this conversation's isolated workspace.`,
        });
        return true;
      }

      if (room.onboarding === "token") {
        if (body.length < 10) {
          yield* ctx.send(room.roomId, { type: "info", text: "That doesn't look like a token — send the GitHub PAT for this room." });
          return true;
        }
        room.token = body;
        // No model question: every room starts on the default injected via
        // DEFAULT_CODING_AGENT_MODEL and can override per room with /model.
        room.model = ctx.defaultModel;
        room.onboarding = undefined;
        ctx.registry.save(room);
        // Best-effort: strip the PAT out of chat history right after reading it.
        // Not a security boundary (the platform may retain it briefly, and
        // deletion can't reach anywhere the message already federated), just
        // closes the main practical exposure — nobody scrolling back sees it.
        // The adapter reports honestly whether it managed (e.g. Matrix
        // redaction needs moderator power level).
        const redacted = msg.messageId && ctx.adapter.capabilities.canRedact ? yield* ctx.adapter.redact(room.roomId, msg.messageId) : false;
        yield* ctx.send(room.roomId, present.tokenReceived(redacted));
        yield* ctx.completeOnboarding(room);
        return true;
      }

      return false;
    }),
};
