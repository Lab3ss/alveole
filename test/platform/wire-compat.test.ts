/**
 * Wire-compatibility snapshot — AC-2. The refactor must not change a single
 * byte the room sees: the composed AGENT_RULES and every coding event's
 * rendered Matrix text are pinned to the values the pre-split code produced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renderOutbound } from "../../src/platform/adapter/matrix.ts";
import { codingAgentRules } from "../../src/agents/coding/rules.ts";
import * as present from "../../src/agents/coding/present.ts";

const MENTION = "@coding-agent";

// Captured from the pre-split channelRules("@coding-agent").
const OLD_RULES_LEN = 2514;
const OLD_RULES_SHA256 = "c802296ed12969bb00bf38105b098c690506e5ce5c5b8bef6f66f62d57e85aea";

test("composed AGENT_RULES is byte-identical to the pre-split document", () => {
  const rules = codingAgentRules(MENTION);
  assert.equal(rules.length, OLD_RULES_LEN);
  assert.equal(createHash("sha256").update(rules).digest("hex"), OLD_RULES_SHA256);
  // Anchors across all four rules, so a reordering is caught too.
  assert.ok(rules.startsWith("# Chat output rules"));
  assert.ok(rules.includes("## Rule 0 — shared room, only act when addressed"));
  assert.ok(rules.includes("## Rule 1 — plain text only, no Markdown at all"));
  assert.ok(rules.includes("## Rule 2 — chat-native communication"));
  assert.ok(rules.includes("## Rule 3 — challenge when you think it's needed"));
});

test("rebound coding events render to the pre-split Matrix text", () => {
  const cases: Array<[string, ReturnType<typeof present.approvalRequest>]> = [
    ["approval-request", present.approvalRequest("git push", MENTION)],
    ["approval-result (allow)", present.approvalResult(true)],
    ["approval-result (deny)", present.approvalResult(false)],
    ["question (single)", present.question("Which env?", MENTION)],
    ["question (multi)", present.question("1. Which env?\n2. Which branch?", MENTION)],
    ["cost-alert", present.costAlert(5)],
    ["compacted", present.compacted()],
    ["token-received (redacted)", present.tokenReceived(true)],
    ["token-received (not redacted)", present.tokenReceived(false)],
    ["teardown", present.teardown("requested", "owner/name")],
  ];
  assert.deepEqual(cases.map(([, e]) => e.type), [
    "info", "info", "info", "info", "info", "info", "info", "info", "info", "info",
  ]);

  const rendered = cases.map(([name, e]) => [name, renderOutbound(e)] as const);
  assert.ok(rendered.every(([, text]) => typeof text === "string" && text.length > 0));

  assert.equal(
    renderOutbound(present.approvalRequest("git push", MENTION)),
    "🔐 Approval needed:\ngit push\nReply *yes* to allow, anything else to deny.\nDon't forget to mention me with @coding-agent in your answer.",
  );
  assert.equal(renderOutbound(present.approvalResult(true)), "✅ Approved — proceeding.");
  assert.equal(renderOutbound(present.approvalResult(false)), "🚫 Denied.");
  assert.equal(
    renderOutbound(present.question("Which env?", MENTION)),
    "❓ Which env?\nDon't forget to mention me with @coding-agent in your answer.",
  );
  assert.equal(
    renderOutbound(present.question("1. Which env?\n2. Which branch?", MENTION)),
    "❓ 1. Which env?\n2. Which branch?\nSend your answers one per line.\nDon't forget to mention me with @coding-agent in your answer.",
  );
  assert.equal(
    renderOutbound(present.costAlert(5)),
    "💸 ~$5 spent so far this session. Send /usage for the full breakdown.",
  );
  assert.equal(
    renderOutbound(present.compacted()),
    "🗜️ Context got compacted (older history was trimmed to make room).",
  );
  assert.equal(renderOutbound(present.tokenReceived(true)), "Got it (and removed from history).");
  assert.equal(
    renderOutbound(present.tokenReceived(false)),
    "Got it. ⚠️ I couldn't remove that message from history (I need moderator power level in this room to redact it) — make me a moderator if you want that.",
  );
  assert.equal(
    renderOutbound(present.teardown("requested", "owner/name")),
    "🛑 Stopped (requested). owner/name is still remembered — send a message to resume.",
  );
});

test("base events render with the same rules as before", () => {
  assert.equal(renderOutbound({ type: "info", text: "hi" }), "hi");
  assert.equal(renderOutbound({ type: "status", text: "hi" }), "hi");
  assert.equal(renderOutbound({ type: "result", text: "hi" }), "hi");
  assert.equal(renderOutbound({ type: "usage", text: "hi" }), "hi");
  assert.equal(renderOutbound({ type: "error", text: "boom" }), "⚠️ boom");
});
