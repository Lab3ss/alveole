/**
 * Coding-specific phrasing: the PAT acknowledgement and the teardown notice
 * (which names the repo). The generic prompts live in harness/opencode/present.ts.
 */
import type { OutboundEvent } from "../../platform/adapter/types.ts";

export const tokenReceived = (redacted: boolean): OutboundEvent => ({
  type: "info",
  text: redacted
    ? "Got it (and removed from history)."
    : "Got it. ⚠️ I couldn't remove that message from history (I need moderator power level in this room to redact it) — make me a moderator if you want that.",
});

export const teardown = (reason: string, repo: string): OutboundEvent => ({
  type: "info",
  text: `🛑 Stopped (${reason}). ${repo} is still remembered — send a message to resume.`,
});
