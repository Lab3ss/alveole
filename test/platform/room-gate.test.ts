import { test } from "node:test";
import assert from "node:assert/strict";
import { AMBIENT_MAX_CHARS, createRoomGate } from "../../src/platform/room-gate.ts";

const base = { conversationId: "!r", senderName: "Alice", text: "hello" };

test("an unmentioned message is buffered as ambient and not admitted", () => {
  const gate = createRoomGate();
  assert.deepEqual(gate.admit({ ...base, mentioned: false }), { addressed: false });
  assert.equal(gate.drain("!r"), "Alice: hello");
});

test("an addressed message is admitted with raw (mention kept) and directive body", () => {
  const gate = createRoomGate();
  assert.deepEqual(
    gate.admit({ ...base, mentioned: true, text: "@bot do it", directive: "do it" }),
    { addressed: true, raw: "@bot do it", body: "do it" },
  );
});

test("a missing directive falls back to the raw text", () => {
  const gate = createRoomGate();
  assert.deepEqual(gate.admit({ ...base, mentioned: true, text: "do it" }), {
    addressed: true,
    raw: "do it",
    body: "do it",
  });
});

test("an empty message is attributed as (empty message)", () => {
  const gate = createRoomGate();
  gate.admit({ ...base, mentioned: false, text: "   " });
  assert.equal(gate.drain("!r"), "Alice: (empty message)");
});

test("drain clears the buffer", () => {
  const gate = createRoomGate();
  gate.admit({ ...base, mentioned: false });
  assert.equal(gate.drain("!r"), "Alice: hello");
  assert.equal(gate.drain("!r"), "");
});

test("the ambient transcript is capped at AMBIENT_MAX_CHARS (newest kept, dropped from the front)", () => {
  const gate = createRoomGate();
  gate.admit({ ...base, mentioned: false, senderName: "Oldest", text: "OLD".repeat(3000) });
  gate.admit({ ...base, mentioned: false, senderName: "Newest", text: "NEWEST-MARKER" });
  const transcript = gate.drain("!r");
  assert.ok(transcript.length <= AMBIENT_MAX_CHARS, `expected <= ${AMBIENT_MAX_CHARS}, got ${transcript.length}`);
  assert.ok(transcript.includes("NEWEST-MARKER")); // newest retained
  assert.ok(!transcript.includes("OLDOLDOLD")); // oldest dropped from the front
});

test("a single oversized message is still kept (at least one entry)", () => {
  const gate = createRoomGate();
  gate.admit({ ...base, mentioned: false, senderName: "Alice", text: "x".repeat(20000) });
  const transcript = gate.drain("!r");
  assert.equal(transcript.length, AMBIENT_MAX_CHARS); // clipped from the front, never emptied
});

test("frame labels the ambient transcript as non-actionable background", () => {
  const gate = createRoomGate();
  const framed = gate.frame("Alice: hi", "@bot go");
  assert.ok(framed.includes("Background"));
  assert.ok(framed.includes("Alice: hi"));
  assert.ok(framed.includes("The following message is addressed to you:"));
  assert.ok(framed.endsWith("@bot go"));
});
