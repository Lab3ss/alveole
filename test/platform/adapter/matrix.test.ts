import { test } from "node:test";
import assert from "node:assert/strict";
import { isBotMentioned, stripMention } from "../../../src/platform/adapter/matrix.ts";
import { channelRulesFor } from "../../../src/platform/channel-rules.ts";
import { codingAgentRules } from "../../../src/agents/coding/rules.ts";

const ME = "@coding-agent:matrix.example.org";
const TOKENS = [ME, "@coding-agent", "Coding Agent"];

test("m.mentions.user_ids is the authoritative trigger", () => {
  assert.equal(isBotMentioned(ME, { body: "hey", "m.mentions": { user_ids: [ME] } }), true);
  assert.equal(isBotMentioned(ME, { body: "hey", "m.mentions": { user_ids: ["@other:x"] } }), false);
});

test("@room alone does not trigger the bot", () => {
  assert.equal(isBotMentioned(ME, { body: "@room standup in 5", "m.mentions": { room: true } }), false);
});

test("a literal @localpart or @mxid is the fallback trigger; a bare name is not", () => {
  assert.equal(isBotMentioned(ME, { body: "@coding-agent take a look" }), true);
  assert.equal(isBotMentioned(ME, { body: "cc @coding-agent:matrix.example.org" }), true);
  assert.equal(isBotMentioned(ME, { body: "the coding-agent is cool" }), false);
  assert.equal(isBotMentioned(ME, { body: "@coding-agent-2 hello" }), false);
});

test("stripMention removes a leading mention token and its separator", () => {
  assert.equal(stripMention("@coding-agent /stop", TOKENS), "/stop");
  assert.equal(stripMention("Coding Agent: fix it", TOKENS), "fix it");
  assert.equal(stripMention("@coding-agent:matrix.example.org yes", TOKENS), "yes");
  assert.equal(stripMention("@Coding Agent, please go", TOKENS), "please go");
});

test("stripMention leaves an unmatched message untouched", () => {
  assert.equal(stripMention("no mention here", TOKENS), "no mention here");
  assert.equal(stripMention("@coding-agency hello", TOKENS), "@coding-agency hello");
});

test("an authoritative mention is stripped even when glued to the payload", () => {
  // The reported bug: a mention pill butted against the answer, e.g. from a
  // client that renders the mention without a trailing space. The default
  // boundary guard refuses to strip it; the authoritative signal recovers it.
  assert.equal(stripMention("@coding-agentyes", TOKENS, { authoritative: true }), "yes");
  assert.equal(stripMention("coding-agentyes", TOKENS, { authoritative: true }), "yes");
  assert.equal(
    stripMention("@coding-agent:matrix.example.orgyes", TOKENS, { authoritative: true }),
    "yes",
  );
  // Without the authoritative signal the boundary guard still holds.
  assert.equal(stripMention("@coding-agentyes", TOKENS), "@coding-agentyes");
});

test("codingAgentRules names the bot's own handle", () => {
  const rules = codingAgentRules(channelRulesFor("@coding-agent"));
  assert.ok(rules.includes("@coding-agent"));
  assert.ok(rules.includes("only act when addressed"));
});
