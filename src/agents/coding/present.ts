/**
 * The coding presenter — maps this agent's richer semantics onto the platform's
 * base OutboundEvent union. The channel renders only base events, so all the
 * coding-specific phrasing lives here, not in the adapter. Texts are
 * byte-identical to the ones the Matrix adapter used to render inline.
 */
import type { OutboundEvent } from "../../platform/adapter/types.ts";

const DEFAULT_MENTION = "@coding-agent";

export const approvalRequest = (description: string, mention = DEFAULT_MENTION): OutboundEvent => ({
  type: "info",
  text: `🔐 Approval needed:\n${description}\nReply *yes* to allow, anything else to deny.\nDon't forget to mention me with ${mention} in your answer.`,
});

export const approvalResult = (approved: boolean): OutboundEvent => ({
  type: "info",
  text: approved ? "✅ Approved — proceeding." : "🚫 Denied.",
});

export const question = (description: string, mention = DEFAULT_MENTION): OutboundEvent => ({
  type: "info",
  text:
    `❓ ${description}\n` +
    (description.includes("\n") ? "Send your answers one per line.\n" : "") +
    `Don't forget to mention me with ${mention} in your answer.`,
});

export const costAlert = (stepUsd: number): OutboundEvent => ({
  type: "info",
  text: `💸 ~$${stepUsd} spent so far this session. Send /usage for the full breakdown.`,
});

export const compacted = (): OutboundEvent => ({
  type: "info",
  text: "🗜️ Context got compacted (older history was trimmed to make room).",
});

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
