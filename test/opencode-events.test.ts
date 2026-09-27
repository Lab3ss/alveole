import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchEvent, type SseHandlers } from "../src/opencode.ts";

function recording(): SseHandlers & { calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = {
    onPermission: [],
    onProgress: [],
    onSessionError: [],
    onCostUpdate: [],
    onCompacted: [],
  };
  return {
    calls,
    onPermission: (r) => calls.onPermission.push(r),
    onProgress: (p) => calls.onProgress.push(p),
    onSessionError: (e) => calls.onSessionError.push(e),
    onCostUpdate: (u) => calls.onCostUpdate.push(u),
    onCompacted: (s) => calls.onCompacted.push(s),
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
