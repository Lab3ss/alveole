import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchEvent, extractTurnResult, type SseHandlers } from "../../../src/agents/coding/opencode.ts";

function recording(): SseHandlers & { calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = {
    onPermission: [],
    onProgress: [],
    onSessionError: [],
    onCostUpdate: [],
    onCompacted: [],
    onIdle: [],
    onQuestion: [],
  };
  return {
    calls,
    onPermission: (r) => calls.onPermission.push(r),
    onProgress: (p) => calls.onProgress.push(p),
    onSessionError: (e) => calls.onSessionError.push(e),
    onCostUpdate: (u) => calls.onCostUpdate.push(u),
    onCompacted: (s) => calls.onCompacted.push(s),
    onIdle: (s) => calls.onIdle.push(s),
    onQuestion: (ask) => calls.onQuestion.push(ask),
  };
}

test("permission event routes to onPermission (real v1.18 wire shape: id, not permissionID)", () => {
  const h = recording();
  dispatchEvent(
    {
      type: "permission.updated",
      properties: {
        id: "per_1",
        type: "bash",
        sessionID: "ses1",
        messageID: "msg1",
        title: "Run npm test",
        metadata: {},
        time: { created: 0 },
      },
    },
    h,
  );
  assert.deepEqual(h.calls.onPermission, [{ sessionId: "ses1", permissionId: "per_1", description: "Run npm test" }]);
  assert.equal(h.calls.onProgress.length, 0);
});

test("permission without title falls back to metadata.command then permission name", () => {
  const h = recording();
  dispatchEvent(
    {
      type: "permission.updated",
      properties: {
        id: "per_2",
        type: "external_directory",
        sessionID: "ses1",
        permission: "external_directory",
        metadata: { command: "cat /tmp/now.txt" },
      },
    },
    h,
  );
  assert.deepEqual(h.calls.onPermission, [{ sessionId: "ses1", permissionId: "per_2", description: "cat /tmp/now.txt" }]);
});

test("permission.replied (our own answer echoed back) does not re-ask", () => {
  const h = recording();
  dispatchEvent(
    { type: "permission.replied", properties: { sessionID: "ses1", permissionID: "per_1", response: "allow" } },
    h,
  );
  assert.equal(h.calls.onPermission.length, 0);
});

test("v1.18 permission.asked: bare permission name + pattern becomes 'read: .env.example'", () => {
  const h = recording();
  dispatchEvent(
    {
      type: "permission.asked",
      properties: {
        id: "per_3",
        sessionID: "ses1",
        permission: "read",
        patterns: [".env.example"],
        metadata: {},
        always: ["*"],
      },
    },
    h,
  );
  assert.deepEqual(h.calls.onPermission, [{ sessionId: "ses1", permissionId: "per_3", description: "read: .env.example" }]);
});

test("edit ask prefers the workspace-relative pattern over the absolute metadata filepath", () => {
  const h = recording();
  dispatchEvent(
    {
      type: "permission.asked",
      properties: {
        id: "per_4",
        sessionID: "ses1",
        permission: "edit",
        patterns: ["src/a.ts"],
        metadata: { filepath: "/home/node/workspace/src/a.ts", diff: "..." },
        always: ["*"],
      },
    },
    h,
  );
  assert.deepEqual(h.calls.onPermission, [{ sessionId: "ses1", permissionId: "per_4", description: "edit: src/a.ts" }]);
});

test("v2 permission.v2.asked builds the description from action + resources", () => {
  const h = recording();
  dispatchEvent(
    {
      type: "permission.v2.asked",
      properties: { id: "per_5", sessionID: "ses1", action: "bash", resources: ["git push origin main"] },
    },
    h,
  );
  assert.deepEqual(h.calls.onPermission, [{ sessionId: "ses1", permissionId: "per_5", description: "bash: git push origin main" }]);
});

test("tool-running event routes to onProgress", () => {
  const h = recording();
  dispatchEvent(
    {
      type: "message.part.updated",
      properties: {
        part: { type: "tool", sessionID: "ses1", tool: "bash", state: { status: "running", title: "npm test" } },
      },
    },
    h,
  );
  assert.deepEqual(h.calls.onProgress, [{ sessionId: "ses1", title: "npm test" }]);
});

test("non-running tool states don't emit progress", () => {
  const h = recording();
  dispatchEvent(
    { type: "message.part.updated", properties: { part: { type: "tool", state: { status: "completed" } } } },
    h,
  );
  assert.equal(h.calls.onProgress.length, 0);
});

test("session error, cost update, and compaction route correctly", () => {
  const h = recording();
  dispatchEvent({ type: "session.error", properties: { sessionID: "ses1", error: { message: "boom" } } }, h);
  dispatchEvent(
    { type: "session.updated", properties: { sessionID: "ses1", info: { cost: 1.25 } } },
    h,
  );
  dispatchEvent({ type: "session.compacted", properties: { sessionID: "ses1" } }, h);
  assert.deepEqual(h.calls.onSessionError, [{ sessionId: "ses1", message: '{"message":"boom"}' }]);
  assert.deepEqual(h.calls.onCostUpdate, [{ sessionId: "ses1", cost: 1.25 }]);
  assert.deepEqual(h.calls.onCompacted, ["ses1"]);
});

test("absent cost is passed through as undefined, not crashed on", () => {
  const h = recording();
  dispatchEvent({ type: "session.updated", properties: { sessionID: "ses1", info: {} } }, h);
  assert.deepEqual(h.calls.onCostUpdate, [{ sessionId: "ses1", cost: undefined }]);
});

test("unknown/malformed events are ignored", () => {
  const h = recording();
  dispatchEvent({ type: "storage.write", properties: { key: "x" } }, h);
  dispatchEvent({}, h);
  assert.equal(
    h.calls.onPermission.length + h.calls.onProgress.length + h.calls.onSessionError.length +
      h.calls.onCostUpdate.length + h.calls.onCompacted.length,
    0,
  );
});

test("/global/event's { directory, payload } envelope is unwrapped before dispatch", () => {
  const h = recording();
  dispatchEvent(
    {
      directory: "/home/node/workspace",
      payload: {
        type: "permission.updated",
        properties: { id: "per_3", sessionID: "ses1", title: "git push" },
      },
    },
    h,
  );
  dispatchEvent(
    {
      directory: "/home/node/workspace",
      payload: {
        type: "message.part.updated",
        properties: { part: { type: "tool", sessionID: "ses1", tool: "bash", state: { status: "running", title: "ls" } } },
      },
    },
    h,
  );
  assert.deepEqual(h.calls.onPermission, [{ sessionId: "ses1", permissionId: "per_3", description: "git push" }]);
  assert.deepEqual(h.calls.onProgress, [{ sessionId: "ses1", title: "ls" }]);
});

test("nested payload without a type is not double-unwrapped into a bare event", () => {
  const h = recording();
  dispatchEvent({ directory: "/x", payload: { properties: { sessionID: "ses1" } } }, h);
  assert.equal(h.calls.onCompacted.length, 0);
});

test("question.asked routes to onQuestion, numbering only when there's more than one question", () => {
  const h = recording();
  dispatchEvent(
    {
      type: "question.asked",
      properties: {
        id: "que_1",
        sessionID: "ses1",
        questions: [
          { question: "Which env?", options: [{ label: "staging" }, { label: "prod" }] },
          { question: "Which branch?" },
        ],
      },
    },
    h,
  );
  assert.deepEqual(h.calls.onQuestion, [
    {
      sessionId: "ses1",
      requestId: "que_1",
      description: "1. Which env? (options: staging, prod)\n2. Which branch?",
      count: 2,
    },
  ]);
});

test("a single question isn't numbered", () => {
  const h = recording();
  dispatchEvent(
    { type: "question.asked", properties: { id: "que_2", sessionID: "ses1", questions: [{ question: "Which env?" }] } },
    h,
  );
  assert.deepEqual(h.calls.onQuestion, [{ sessionId: "ses1", requestId: "que_2", description: "Which env?", count: 1 }]);
});

test("session.idle and session.status:idle both signal turn completion", () => {
  const h = recording();
  dispatchEvent({ type: "session.idle", properties: { sessionID: "ses1" } }, h);
  dispatchEvent({ type: "session.status", properties: { sessionID: "ses1", status: { type: "idle" } } }, h);
  assert.deepEqual(h.calls.onIdle, ["ses1", "ses1"]);
});

test("busy/retry session status does not signal completion", () => {
  const h = recording();
  dispatchEvent({ type: "session.status", properties: { sessionID: "ses1", status: { type: "busy" } } }, h);
  dispatchEvent({ type: "session.status", properties: { sessionID: "ses1", status: { type: "retry", attempt: 1, message: "x", next: 1 } } }, h);
  assert.equal(h.calls.onIdle.length, 0);
});

// ---------------------------------------------------------------------------
// extractTurnResult — the reply-pull that replaces the blocking POST response.
// ---------------------------------------------------------------------------

const msg = (info: any, parts: Array<any> = []) => ({ info, parts });

test("extractTurnResult takes the LAST assistant message of the turn (per-step messages)", () => {
  const messages = [
    msg({ role: "user", id: "u1" }, [{ type: "text", text: "fix the bug" }]),
    msg({ role: "assistant", parentID: "u1" }, [{ type: "text", text: "narration around tools" }, { type: "tool" }]),
    msg({ role: "assistant", parentID: "u1" }, [{ type: "text", text: "final answer" }]),
  ];
  assert.deepEqual(extractTurnResult(messages), { text: "final answer" });
});

test("extractTurnResult falls back to the last assistant message when the user message is missing", () => {
  const messages = [
    msg({ role: "assistant", parentID: "u_gone" }, [{ type: "text", text: "orphaned answer" }]),
  ];
  assert.deepEqual(extractTurnResult(messages), { text: "orphaned answer" });
});

test("extractTurnResult surfaces a rejected turn's info.error instead of a blank reply", () => {
  const messages = [
    msg({ role: "user", id: "u1" }, [{ type: "text", text: "huge task" }]),
    msg({ role: "assistant", parentID: "u1", error: { name: "ContextTooLarge", data: { message: "trim it" } } }, []),
  ];
  assert.deepEqual(extractTurnResult(messages), { text: "", error: "trim it" });
});

test("extractTurnResult without any data.message falls back to the error name", () => {
  const messages = [
    msg({ role: "assistant", parentID: "u1", error: { name: "MessageAbortedError" } }, []),
  ];
  assert.deepEqual(extractTurnResult(messages), { text: "", error: "MessageAbortedError" });
});

test("extractTurnResult on an empty message list yields empty text, no error", () => {
  assert.deepEqual(extractTurnResult([]), { text: "" });
});
