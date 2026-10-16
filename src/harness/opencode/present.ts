/**
 * The harness presenter — maps the engine's richer semantics (approvals,
 * questions, cost alerts, compaction) onto the platform's base OutboundEvent
 * union. The channel renders only base events, so this phrasing lives here,
 * not in the adapter. Texts are byte-identical to the ones the Matrix adapter
 * used to render inline.
 */
import type { OutboundEvent } from "../../platform/adapter/types.ts";

export const approvalRequest = (description: string, mention: string): OutboundEvent => ({
  type: "info",
  text: `🔐 Approval needed:\n${description}\nReply *yes* to allow, anything else to deny.\nDon't forget to mention me with ${mention} in your answer.`,
});

export const approvalResult = (approved: boolean): OutboundEvent => ({
  type: "info",
  text: approved ? "✅ Approved — proceeding." : "🚫 Denied.",
});

export const question = (description: string, mention: string): OutboundEvent => ({
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
