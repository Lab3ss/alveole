import { test } from "node:test";
import assert from "node:assert/strict";
import { roomResourceName } from "../../../src/harness/opencode/k8s.ts";

test("roomResourceName is DNS-safe and <=63 chars", () => {
  const name = roomResourceName("! projeté très très long ".repeat(5) + "🔥");
  assert.match(name, /^[a-z0-9-]+$/);
  assert.ok(name.length <= 63);
  assert.ok(name.startsWith("room-"));
});

test("roomResourceName is stable per roomId", () => {
  assert.equal(roomResourceName("abc", "My Room"), roomResourceName("abc", "My Room"));
});

test("roomResourceName differs for different rooms sharing a display name", () => {
  assert.notEqual(roomResourceName("roomA", "dev"), roomResourceName("roomB", "dev"));
});

test("roomResourceName works with no room name", () => {
  const name = roomResourceName("xyz");
  assert.match(name, /^room-[0-9a-f]{16}$/);
});

test("roomResourceName without an agent name keeps the historical names (live rooms stay reachable)", () => {
  assert.equal(roomResourceName("abc", "My Room"), roomResourceName("abc", "My Room", undefined));
  assert.match(roomResourceName("abc", "My Room"), /^room-my-room-[0-9a-f]{16}$/);
});

test("roomResourceName separates bots sharing a room", () => {
  const coding = roomResourceName("!room", "dev");
  const botA = roomResourceName("!room", "dev", "bot-a");
  const botB = roomResourceName("!room", "dev", "Bot B");
  assert.notEqual(botA, coding);
  assert.notEqual(botA, botB);
  assert.match(botA, /^room-bot-a-dev-[0-9a-f]{16}$/);
  assert.match(botB, /^room-bot-b-dev-[0-9a-f]{16}$/);
});

test("roomResourceName with an agent name is still DNS-safe and <=63 chars", () => {
  const name = roomResourceName("! projeté très très long ".repeat(5) + "🔥", "x".repeat(80), "a-very-long-agent-name-that-gets-capped");
  assert.match(name, /^[a-z0-9-]+$/);
  assert.ok(name.length <= 63);
});
