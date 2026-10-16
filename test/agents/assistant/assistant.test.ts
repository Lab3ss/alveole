import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ChatAdapter, type ChatAdapterService, type InboundMessage, type OutboundEvent } from "../../../src/platform/adapter/types.ts";
import { Agent } from "../../../src/platform/agent.ts";
import { makeOpencodeAgent, type EngineConfig } from "../../../src/harness/opencode/engine.ts";
import { Registry, type RegistryService } from "../../../src/harness/opencode/registry.ts";
import { Workspace, type WorkspaceService } from "../../../src/harness/opencode/workspace.ts";
import { assistantProfile } from "../../../src/agents/assistant/profile.ts";
import { assistantConfigFromEnv, type AssistantSettings } from "../../../src/agents/assistant/config.ts";
import { assistantRules, DEFAULT_PERSONA } from "../../../src/agents/assistant/rules.ts";
import type { Room } from "../../../src/agents/assistant/registry.ts";

// Same seams as the coding orchestrator test: fakes for the chat adapter, the
// registry and the workspace, so the assistant profile is exercised through the
// real engine with zero Matrix, zero docker, zero opencode.

const CHANNEL = { preamble: "PRE\n", sharedRoom: "SHARED\n", formatting: "FORMAT\n" };
const SETTINGS: AssistantSettings = { runnerImage: "assistant-runner:test", idleHours: 6 };
const ENGINE: EngineConfig = {
  idleTeardownMs: 3600_000,
  sweepIntervalMs: 60_000,
  turnWatchdogMs: 0,
  turnMaxMs: 0,
  sessionCostCapUsd: 0,
  defaultModel: "test/default-model",
};

const recorded: OutboundEvent[] = [];
const rooms = new Map<string, Room>();
const calls = {
  provision: [] as Array<{ env: Record<string, string | undefined>; rules?: string; image?: string }>,
  sent: [] as Array<{ text: string; model?: string }>,
  teardown: 0,
  lastPromptDone: undefined as ((err: string | undefined) => void) | undefined,
};

const adapter: ChatAdapterService = {
  capabilities: { markdown: false, maxMessageChars: 3000, canRedact: true, selfMention: "@haiku", channelRules: CHANNEL },
  start: () => Effect.void,
  send: (_id, event) => Effect.sync(() => void recorded.push(event)),
  redact: () => Effect.succeed(true),
  label: () => Effect.succeed("Test Room"),
  parseApprovalAnswer: (t) => /^(y|yes)\b/i.test(t),
};

const registry: RegistryService = {
  get: (id) => rooms.get(id),
  create: (id) => {
    const r: Room = { roomId: id, lastActivity: Date.now() };
    rooms.set(id, r);
    return r;
  },
  save: (r) => void rooms.set(r.roomId, r as Room),
  touch: () => {},
  idle: () => [],
  delete: (id) => void rooms.delete(id),
};

const workspace: WorkspaceService = {
  resourceName: (id) => `room-haiku-${id.replace(/[^a-z0-9]/gi, "")}`,
  serverUrl: (name) => `http://${name}`,
  provision: (_name, env, rules, image) =>
    Effect.sync(() => {
      calls.provision.push({ env, rules, image });
      return "pw";
    }),
  waitForRunning: () => Effect.void,
  readPodState: () => Effect.succeed("running"),
  teardown: () => Effect.sync(() => void calls.teardown++),
  serverPassword: () => Effect.succeed("pw"),
  createSession: () => Effect.succeed("ses1"),
  probe: () => Effect.void,
  sendPrompt: (_b, _p, _s, text, model, onDone) =>
    Effect.sync(() => {
      calls.sent.push({ text, model });
      calls.lastPromptDone = onDone;
    }),
  turnResult: () => Effect.succeed({ text: `echo: ${calls.sent.at(-1)?.text}` }),
  abort: () => Effect.void,
  usage: () => Effect.succeed({ cost: 0.01 }),
  respondPermission: () => Effect.void,
  answerQuestion: () => Effect.void,
  runShell: () => Effect.void,
  watch: () => Effect.succeed(() => {}),
};

const layers = Layer.mergeAll(
  Layer.succeed(ChatAdapter, adapter),
  Layer.succeed(Registry, registry),
  Layer.succeed(Workspace, workspace),
);

const runtimes: Array<ManagedRuntime.ManagedRuntime<any, any>> = [];
const makeAgent = async (settings: AssistantSettings = SETTINGS) => {
  const rt = ManagedRuntime.make(Layer.provide(Layer.effect(Agent, makeOpencodeAgent(assistantProfile(settings), ENGINE)), layers));
  runtimes.push(rt);
  const agent = await rt.runPromise(Agent);
  return {
    run: (msg: Partial<InboundMessage> & { conversationId: string; text: string }) =>
      Effect.runPromise(agent.handleInbound({ mentioned: true, ...msg })),
    greet: (id: string) => Effect.runPromise(agent.greet(id)),
  };
};
test.after(() => Promise.all(runtimes.map((rt) => rt.dispose())));

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("condition not met within timeout");
};
const texts = () => recorded.map((e) => ("text" in e ? e.text : ""));
const reset = () => {
  recorded.length = 0;
  rooms.clear();
  calls.provision.length = 0;
  calls.sent.length = 0;
  calls.teardown = 0;
  calls.lastPromptDone = undefined;
};

test("the first mention provisions an empty workspace — no onboarding, no repo", async () => {
  reset();
  const { run } = await makeAgent();
  await run({ conversationId: "!r1", text: "@haiku what is a monad?" });
  await until(() => calls.sent.length === 1);

  assert.equal(calls.provision.length, 1);
  assert.deepEqual(calls.provision[0].env, {}); // nothing room-specific injected
  assert.equal(calls.provision[0].image, "assistant-runner:test");
  assert.equal(calls.sent[0].text, "@haiku what is a monad?");
  assert.equal(calls.sent[0].model, "test/default-model");
  assert.ok(!texts().some((t) => /\brepo(sitory)?\b|\bPAT\b|\btoken\b/i.test(t)), "the room is never asked for a repo or token");

  calls.lastPromptDone!(undefined); // turn ends
  await until(() => recorded.some((e) => e.type === "result"));
});

test("AGENT_RULES = channel fragments + assistant persona, with a replaceable persona", async () => {
  reset();
  const a = await makeAgent();
  await a.run({ conversationId: "!r2", text: "@haiku hi" });
  await until(() => calls.provision.length === 1);
  assert.equal(calls.provision[0].rules, assistantRules(CHANNEL));
  assert.ok(calls.provision[0].rules!.startsWith("PRE\nSHARED\nFORMAT\n"));
  assert.ok(calls.provision[0].rules!.endsWith(DEFAULT_PERSONA));
  assert.ok(!/AGENTS\.md|\brepo(sitory)?\b/i.test(calls.provision[0].rules!), "no coding-specific text");

  reset();
  const b = await makeAgent({ ...SETTINGS, systemPrompt: "You are Le Chat, speak French." });
  await b.run({ conversationId: "!r2", text: "@haiku salut" });
  await until(() => calls.provision.length === 1);
  assert.equal(calls.provision[0].rules, "PRE\nSHARED\nFORMAT\nYou are Le Chat, speak French.");
});

test("unmentioned chatter never provisions; it rides along once with the next mention", async () => {
  reset();
  const { run } = await makeAgent();
  await run({ conversationId: "!r3", text: "alice: lunch?", mentioned: false, senderName: "Alice" });
  assert.equal(calls.provision.length, 0);
  assert.equal(recorded.length, 0);

  await run({ conversationId: "!r3", text: "@haiku summarise" });
  await until(() => calls.sent.length === 1);
  assert.match(calls.sent[0].text, /Background/);
  assert.match(calls.sent[0].text, /Alice: alice: lunch\?/);
  assert.match(calls.sent[0].text, /@haiku summarise$/);
});

test("/model creates the room on demand and the model reaches the prompt", async () => {
  reset();
  const { run } = await makeAgent();
  await run({ conversationId: "!r4", text: "@haiku /model mistralai/le-chat-test", directive: "/model mistralai/le-chat-test" });
  assert.equal(rooms.get("!r4")?.model, "mistralai/le-chat-test");
  assert.ok(texts().some((t) => t.startsWith("Model set to mistralai/le-chat-test")));

  await run({ conversationId: "!r4", text: "@haiku go" });
  await until(() => calls.sent.length === 1);
  assert.equal(calls.sent[0].model, "mistralai/le-chat-test");
});

test("/stop tears the workspace down and says the context was reset", async () => {
  reset();
  const { run } = await makeAgent();
  await run({ conversationId: "!r5", text: "@haiku hi" });
  await until(() => calls.sent.length === 1);
  calls.lastPromptDone!(undefined);
  await until(() => recorded.some((e) => e.type === "result"));

  await run({ conversationId: "!r5", text: "@haiku /stop", directive: "/stop" });
  assert.equal(calls.teardown, 1);
  const last = texts().at(-1)!;
  assert.match(last, /Stopped \(requested\)/);
  assert.match(last, /conversation context were reset/);
  assert.equal(rooms.get("!r5")?.podName, undefined);
});

test("greet introduces the bot once, naming its handle and the reset policy", async () => {
  reset();
  const { greet } = await makeAgent();
  await greet("!r6");
  assert.equal(recorded.length, 1);
  assert.match(texts()[0], /@haiku/);
  assert.match(texts()[0], /after 6h idle/);
  await greet("!r6"); // repeat join signal
  assert.equal(recorded.length, 1);
});

test("config: model alias default, per-backend runner image, overrides", () => {
  const d = assistantConfigFromEnv({});
  assert.equal(d.engine.defaultModel, "~anthropic/claude-haiku-latest");
  assert.equal(d.settings.runnerImage, "ghcr.io/lab3ss/alveole-assistant-runner:0.3.0");
  assert.equal(d.settings.systemPrompt, undefined);
  assert.equal(d.engine.idleTeardownMs, 24 * 3600_000);

  const compose = assistantConfigFromEnv({ WORKSPACE_BACKEND: "compose" });
  assert.equal(compose.settings.runnerImage, "alveole-assistant-runner:local");

  const custom = assistantConfigFromEnv({
    ASSISTANT_DEFAULT_MODEL: "mistralai/mistral-medium",
    ASSISTANT_RUNNER_IMAGE: "my/runner:1",
    ASSISTANT_SYSTEM_PROMPT: "Be Le Chat.",
    IDLE_TEARDOWN_HOURS: "2",
  });
  assert.equal(custom.engine.defaultModel, "mistralai/mistral-medium");
  assert.equal(custom.settings.runnerImage, "my/runner:1");
  assert.equal(custom.settings.systemPrompt, "Be Le Chat.");
  assert.equal(custom.engine.idleTeardownMs, 2 * 3600_000);
});
