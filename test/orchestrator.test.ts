import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ChatAdapter, type ChatAdapterService, type InboundMessage, type OutboundEvent } from "../src/adapter/types.ts";
import { Orchestrator, OrchestratorLive } from "../src/core/orchestrator.ts";
import { Registry, type RegistryService, type Room } from "../src/core/registry-service.ts";
import { Workspace, type Failure, type WatchHandlers, type WorkspaceService } from "../src/core/workspace.ts";

// ---------------------------------------------------------------------------
// Fakes — the whole point of the adapter seam: onboarding, commands, and the
// approval flow are tested with zero Matrix, zero k8s, zero opencode.
// ---------------------------------------------------------------------------

const recorded: Array<{ conversationId: string; event: OutboundEvent }> = [];
const rooms = new Map<string, Room>();
const calls = {
  provision: [] as Array<{ name: string; rules?: string }>,
  createSession: [] as string[],
  teardown: [] as string[],
  respond: [] as boolean[],
  questionAnswers: [] as string[][][],
  sent: [] as string[],
  aborted: 0,
  redacted: 0,
  /** Latest sendPrompt onDone callback — tests drive turn completion with it. */
  lastPromptDone: undefined as ((err: string | undefined) => void) | undefined,
};
let watchHandlers: WatchHandlers | undefined;

const fakeAdapter: ChatAdapterService = {
  capabilities: { markdown: false, maxMessageChars: 3000, canRedact: true, agentRules: "FAKE-CHANNEL-RULES" },
  start: () => Effect.void,
  send: (conversationId, event) =>
    Effect.sync(() => {
      recorded.push({ conversationId, event });
    }),
  redact: () =>
    Effect.sync(() => {
      calls.redacted++;
      return true;
    }),
  label: () => Effect.succeed("Test Room"),
  parseApprovalAnswer: (text: string) => /^(y|yes)\b/i.test(text),
};

const fakeRegistry: RegistryService = {
  get: (id) => rooms.get(id),
  create: (id) => {
    const r = { roomId: id, onboarding: "repo" as const, lastActivity: Date.now() } as Room;
    rooms.set(id, r);
    return r;
  },
  save: (r) => rooms.set(r.roomId, r),
  touch: () => {},
  idle: () => [],
  delete: (id) => rooms.delete(id),
};

// Failure toggles — flip these to drive the typed error paths end-to-end.
const failures = {
  provision: false as Failure<"provision-failed"> | false,
  prompt: null as string | null, // sendPrompt early failure (undelivered prompt)
  turnError: null as string | null, // turn rejected (assistant info.error)
  messages: false as Failure<"messages-fetch-failed"> | false,
  usage: false as Failure<"usage-fetch-failed"> | false,
};

const fakeWorkspace: WorkspaceService = {
  resourceName: (id) => `room-test-${id.replace(/[^a-z0-9]/gi, "")}`,
  serverUrl: (name) => `http://${name}`,
  provision: (name, _project, rules) =>
    failures.provision
      ? Effect.fail(failures.provision)
      : Effect.sync(() => {
          calls.provision.push({ name, rules });
          return "server-password";
        }),
  waitForRunning: () => Effect.void,
  readPodState: () => Effect.succeed("running"),
  teardown: (name) =>
    Effect.sync(() => {
      calls.teardown.push(name);
    }),
  serverPassword: () => Effect.succeed("server-password"),
  createSession: (baseUrl) =>
    Effect.sync(() => {
      calls.createSession.push(baseUrl);
      return "ses1";
    }),
  probe: () => Effect.void,
  sendPrompt: (_b, _p, _s, text, _model, onDone) =>
    Effect.sync(() => {
      calls.sent.push(text);
      calls.lastPromptDone = onDone;
      // Undelivered-prompt simulation fires asynchronously, like a real
      // fetch would; a healthy prompt never completes on its own — tests
      // drive completion via watchHandlers.onIdle or lastPromptDone.
      if (failures.prompt) setTimeout(() => onDone(failures.prompt!), 0);
    }),
  turnResult: () =>
    failures.turnError
      ? Effect.succeed({ text: "", error: failures.turnError })
      : failures.messages
        ? Effect.fail(failures.messages)
        : Effect.succeed({ text: `did the thing: ${calls.sent.at(-1) ?? ""}` }),
  abort: () =>
    Effect.sync(() => {
      calls.aborted++;
    }),
  usage: () => (failures.usage ? Effect.fail(failures.usage) : Effect.succeed({ cost: 1.25 })),
  respondPermission: (_b, _p, _s, _pid, approved) =>
    Effect.sync(() => {
      calls.respond.push(approved);
    }),
  answerQuestion: (_b, _p, _s, _rid, answers) =>
    Effect.sync(() => {
      calls.questionAnswers.push(answers);
    }),
  watch: (_b, _p, handlers) =>
    Effect.sync(() => {
      watchHandlers = handlers;
      return () => {};
    }),
};

const layers = Layer.mergeAll(
  Layer.effect(ChatAdapter, Effect.succeed(fakeAdapter)),
  Layer.effect(Registry, Effect.succeed(fakeRegistry)),
  Layer.effect(Workspace, Effect.succeed(fakeWorkspace)),
);

const runtime = ManagedRuntime.make(
  Layer.provide(
    OrchestratorLive({ idleTeardownMs: 3600_000, sweepIntervalMs: 60_000, turnWatchdogMs: 0, turnMaxMs: 0, sessionCostCapUsd: 0 }),
    layers,
  ),
);

// Guardrail runtimes: same fakes, but each caps ONE guardrail so its test is
// deterministic — with several caps armed at once, event-loop jitter under
// the test runner can reorder which timer fires first (real-world ratios are
// 15 min vs 4 h, far beyond any jitter; the race only exists at ms scale).
const createdRuntimes: Array<ManagedRuntime.ManagedRuntime<any, any>> = [];
const guardrailOrchestrator = async (cap: Partial<import("../src/core/orchestrator.ts").OrchestratorConfig>) => {
  const rt = ManagedRuntime.make(
    Layer.provide(
      OrchestratorLive({ idleTeardownMs: 3600_000, sweepIntervalMs: 60_000, turnWatchdogMs: 0, turnMaxMs: 0, sessionCostCapUsd: 0, ...cap }),
      layers,
    ),
  );
  createdRuntimes.push(rt);
  const orch = await rt.runPromise(
    Effect.gen(function* () {
      return yield* Orchestrator;
    }),
  );
  return (msg: TestMsg) => Effect.runPromise(orch.handleInbound({ mentioned: true, ...msg }));
};

test.after(() => Promise.all([runtime.dispose(), ...createdRuntimes.map((rt) => rt.dispose())]));

const orchestrator = await runtime.runPromise(
  Effect.gen(function* () {
    return yield* Orchestrator;
  }),
);

/** handleInbound is a context-free Effect — run it explicitly (awaiting the
 * Effect object itself would be a silent no-op).
 *
 * `mentioned` defaults to true here so existing tests keep exercising the
 * addressed path; pass `mentioned: false` to test ambient conversation. */
type TestMsg = Omit<InboundMessage, "mentioned"> & { mentioned?: boolean };
const run = (msg: TestMsg) => Effect.runPromise(orchestrator.handleInbound({ mentioned: true, ...msg }));

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("condition not met within timeout");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const reset = () => {
  recorded.length = 0;
  rooms.clear();
  calls.provision.length = 0;
  calls.createSession.length = 0;
  calls.teardown.length = 0;
  calls.respond.length = 0;
  calls.questionAnswers.length = 0;
  calls.sent.length = 0;
  calls.aborted = 0;
  calls.redacted = 0;
  calls.lastPromptDone = undefined;
  failures.provision = false;
  failures.prompt = null;
  failures.turnError = null;
  failures.messages = false;
  failures.usage = false;
  watchHandlers = undefined;
};

/** Full onboarding flow for one conversation — needed because reset() clears
 * the fake registry; every test must set up its own room. */
const onboard = async (id = "!t1", runner: (m: TestMsg) => Promise<void> = run) => {
  await runner({ conversationId: id, text: "lab3ss/alveole" });
  await runner({ conversationId: id, text: "ghp_token1234567", messageId: "$m1" });
  await runner({ conversationId: id, text: "anthropic/claude-sonnet-4.5" });
};

test("onboarding collects repo → token → model, then provisions the workspace", async () => {
  reset();
  await run({ conversationId: "!t1", text: "lab3ss/alveole" });
  assert.equal(rooms.get("!t1")?.onboarding, "token");
  assert.ok(recorded.some((r) => r.event.type === "info" && r.event.text.includes("GitHub PAT")));

  await run({ conversationId: "!t1", text: "ghp_token1234567", messageId: "$m1" });
  assert.equal(rooms.get("!t1")?.token, "ghp_token1234567");
  assert.equal(rooms.get("!t1")?.onboarding, "model");
  assert.equal(calls.redacted, 1); // PAT scrubbed via the adapter capability

  await run({ conversationId: "!t1", text: "anthropic/claude-sonnet-4.5" });
  assert.equal(rooms.get("!t1")?.model, "anthropic/claude-sonnet-4.5");
  assert.equal(rooms.get("!t1")?.podName, "room-test-t1");
  assert.equal(rooms.get("!t1")?.sessionId, "ses1");
  assert.equal(calls.provision.length, 1);
  // The channel's formatting capability profile is injected into the pod.
  assert.equal(calls.provision[0].rules, "FAKE-CHANNEL-RULES");
  const last = recorded[recorded.length - 1];
  assert.equal(last.event.type, "info");
  assert.ok(last.event.type === "info" && last.event.text.includes("Ready"));
});

test("steady-state task: prompt fired, room busy, SSE idle relays the result and releases the room", async () => {
  reset();
  await onboard("!t2");
  await run({ conversationId: "!t2", text: "fix the login bug" });
  assert.deepEqual(calls.sent, ["fix the login bug"]);
  // The turn is in flight (asynchronous) — a second message is declined.
  await run({ conversationId: "!t2", text: "and this too" });
  assert.ok(recorded.some((r) => r.event.type === "info" && r.event.text.includes("Still working")));
  assert.deepEqual(calls.sent, ["fix the login bug"]);
  // Completion arrives via the SSE idle signal: reply pulled from the message
  // list, room released.
  watchHandlers!.onIdle("ses1");
  await until(() => recorded.some((r) => r.event.type === "result"));
  const result = recorded.find((r) => r.event.type === "result");
  assert.ok(result);
  assert.equal(result.event.type === "result" && result.event.text, "did the thing: fix the login bug");
  await run({ conversationId: "!t2", text: "one more" });
  assert.deepEqual(calls.sent, ["fix the login bug", "one more"]);
});

test("a live pod with a lost sessionId (half-finished provision) re-creates the session instead of prompting at /session/undefined", async () => {
  reset();
  await onboard("!t2c");
  const before = calls.createSession.length;
  // Simulate the createSession-failed-mid-provision state: pod alive in the
  // registry, but no sessionId was ever recorded (e.g. the server wasn't
  // listening within the retry budget when the pod was first provisioned).
  rooms.get("!t2c")!.sessionId = undefined;
  await run({ conversationId: "!t2c", text: "fix the login bug" });
  assert.equal(calls.createSession.length, before + 1);
  assert.ok(calls.createSession.at(-1)!.includes("room-test-t2c"));
  assert.equal(rooms.get("!t2c")?.sessionId, "ses1");
  assert.deepEqual(calls.sent, ["fix the login bug"]);
  assert.ok(!recorded.some((r) => r.event.type === "error"));
  watchHandlers!.onIdle("ses1");
  await until(() => recorded.some((r) => r.event.type === "result"));
});

test("POST resolution is a redundant completion signal when the SSE idle event is missed", async () => {
  reset();
  await onboard("!t2b");
  await run({ conversationId: "!t2b", text: "fix the login bug" });
  calls.lastPromptDone!(undefined); // POST resolved (turn end), no idle event
  await until(() => recorded.some((r) => r.event.type === "result"));
  const result = recorded.find((r) => r.event.type === "result");
  assert.ok(result);
  assert.equal(result.event.type === "result" && result.event.text, "did the thing: fix the login bug");
  // Double completion is a no-op (idle also fires after the POST resolved).
  watchHandlers!.onIdle("ses1");
  await sleep(50);
  assert.equal(recorded.filter((r) => r.event.type === "result").length, 1);
});

test("permission request is asked in the room; 'yes' relays allow to opencode", async () => {
  reset();
  await onboard("!t3");
  watchHandlers!.onPermission({ sessionId: "ses1", permissionId: "p1", description: "git push" });
  await until(() => recorded.some((r) => r.event.type === "approval-request"));

  await run({ conversationId: "!t3", text: "yes" });
  assert.deepEqual(calls.respond, [true]);
  const decision = recorded.find((r) => r.event.type === "approval-result");
  assert.ok(decision);
  assert.equal(decision.event.type === "approval-result" && decision.event.approved, true);
});

test("'no' denies and is relayed as deny", async () => {
  reset();
  await onboard("!t4");
  watchHandlers!.onPermission({ sessionId: "ses1", permissionId: "p2", description: "rm -rf /" });
  await until(() => recorded.some((r) => r.event.type === "approval-request"));

  await run({ conversationId: "!t4", text: "absolutely not" });
  assert.deepEqual(calls.respond, [false]);
});

test("a single question is answered with the whole reply, and the turn isn't left hanging", async () => {
  reset();
  await onboard("!t4b");
  await run({ conversationId: "!t4b", text: "build the feature" });
  watchHandlers!.onQuestion({ sessionId: "ses1", requestId: "q1", description: "Which env, staging or prod?", count: 1 });
  await until(() => recorded.some((r) => r.event.type === "question"));

  await run({ conversationId: "!t4b", text: "staging" });
  assert.deepEqual(calls.questionAnswers, [[["staging"]]]);
  // Answering releases the room instead of leaving the turn to hang until the
  // watchdog eventually times it out — the whole point of this feature.
  watchHandlers!.onIdle("ses1");
  await until(() => recorded.some((r) => r.event.type === "result"));
  await run({ conversationId: "!t4b", text: "next task" });
  assert.deepEqual(calls.sent, ["build the feature", "next task"]);
});

test("a multi-question ask maps one reply line to each question, in order", async () => {
  reset();
  await onboard("!t4c");
  await run({ conversationId: "!t4c", text: "build the feature" });
  watchHandlers!.onQuestion({
    sessionId: "ses1",
    requestId: "q2",
    description: "1. Which env?\n2. Which branch?",
    count: 2,
  });
  await until(() => recorded.some((r) => r.event.type === "question"));

  await run({ conversationId: "!t4c", text: "staging\nmain" });
  assert.deepEqual(calls.questionAnswers, [[["staging"], ["main"]]]);
  watchHandlers!.onIdle("ses1");
  await until(() => recorded.some((r) => r.event.type === "result"));
});

test("/stop works while a question is pending and resolves it without POSTing", async () => {
  reset();
  await onboard("!t4d");
  watchHandlers!.onQuestion({ sessionId: "ses1", requestId: "q3", description: "Which env?", count: 1 });
  await until(() => recorded.some((r) => r.event.type === "question"));

  await run({ conversationId: "!t4d", text: "/stop" });
  assert.equal(calls.teardown.length, 1);
  assert.equal(calls.questionAnswers.length, 0); // answered ([]) locally, never POSTed to the dead pod
});

test("/stop works while an approval is pending and resolves it without POSTing", async () => {
  reset();
  await onboard("!t5");
  watchHandlers!.onPermission({ sessionId: "ses1", permissionId: "p3", description: "git push" });
  await until(() => recorded.some((r) => r.event.type === "approval-request"));

  await run({ conversationId: "!t5", text: "/stop" });
  assert.equal(calls.teardown.length, 1);
  assert.equal(calls.respond.length, 0); // answered (denied) locally, never POSTed to the dead pod
  assert.equal(rooms.get("!t5")?.podName, undefined);
  const td = recorded.find((r) => r.event.type === "teardown");
  assert.ok(td);
  assert.equal(td.event.type === "teardown" && td.event.reason, "requested");
});

test("abandoned conversation tears down the pod and purges the registry row", async () => {
  reset();
  await onboard("!t5b");
  assert.ok(rooms.has("!t5b"));

  await Effect.runPromise(orchestrator.abandon("!t5b"));
  assert.ok(!rooms.has("!t5b"));
  assert.equal(calls.teardown.length, 1);
  assert.equal(calls.teardown[0], "room-test-t5b");
  // No outbound event for this one — nobody is left in the conversation to read it.
  assert.equal(recorded.filter((r) => r.conversationId === "!t5b").at(-1)?.event.type, "info");
});

test("abandoning a conversation that never onboarded is a no-op", async () => {
  reset();
  await Effect.runPromise(orchestrator.abandon("!never-seen"));
  assert.equal(calls.teardown.length, 0);
});

test("joining a conversation proactively greets with the onboarding opener", async () => {
  reset();
  await Effect.runPromise(orchestrator.greet("!joined"));
  assert.equal(rooms.get("!joined")?.onboarding, "repo");
  const info = recorded.find((r) => r.conversationId === "!joined" && r.event.type === "info");
  assert.ok(info);
  assert.ok(info.event.type === "info" && info.event.text.includes("what repo should I work on"));
});

test("greeting a conversation that is already known is a no-op", async () => {
  reset();
  await onboard("!t11");
  recorded.length = 0;
  await Effect.runPromise(orchestrator.greet("!t11"));
  assert.equal(recorded.length, 0);
});

test("/model updates per-message routing without touching the pod", async () => {
  reset();
  await onboard("!t6");
  await run({ conversationId: "!t6", text: "/model openai/gpt-5.2" });
  assert.equal(rooms.get("!t6")?.model, "openai/gpt-5.2");
  assert.equal(calls.provision.length, 1); // onboarding provisioned once; /model must not re-provision
  assert.ok(recorded.some((r) => r.event.type === "info" && r.event.text.includes("Model set to")));
});

test("broken input during onboarding re-asks instead of provisioning", async () => {
  reset();
  await run({ conversationId: "!t7", text: "fix the login bug please" });
  assert.equal(rooms.get("!t7")?.onboarding, "repo"); // no repo parsed, still asking
  assert.equal(calls.provision.length, 0);
});

test("onboarding provision failure surfaces the typed code in the room", async () => {
  reset();
  await run({ conversationId: "!t8", text: "lab3ss/alveole" });
  await run({ conversationId: "!t8", text: "ghp_token1234567", messageId: "$m1" });
  failures.provision = { code: "provision-failed", details: "boom" };
  await run({ conversationId: "!t8", text: "anthropic/claude-sonnet-4.5" });
  const err = recorded.find((r) => r.event.type === "error");
  assert.ok(err);
  assert.equal(err.event.type === "error" && err.event.text, "setup failed: provision-failed — boom");
});

test("undelivered prompt surfaces the error, doesn't abort (nothing running server-side) and releases the room", async () => {
  reset();
  await onboard("!t9");
  failures.prompt = "ConnectError: connection refused";
  await run({ conversationId: "!t9", text: "fix the login bug" });
  await until(() => recorded.some((r) => r.event.type === "error"));
  const err = recorded.find((r) => r.event.type === "error");
  assert.ok(err);
  assert.equal(
    err.event.type === "error" && err.event.text,
    "task failed: prompt not delivered — ConnectError: connection refused",
  );
  assert.equal(calls.aborted, 0); // the prompt never reached opencode — nothing to abort
  await run({ conversationId: "!t9", text: "try again" });
  assert.deepEqual(calls.sent, ["fix the login bug", "try again"]); // room released
});

test("rejected turn (assistant info.error) surfaces the real failure, not a blank reply", async () => {
  reset();
  await onboard("!t9b");
  failures.turnError = "context too large for model";
  await run({ conversationId: "!t9b", text: "fix the login bug" });
  watchHandlers!.onIdle("ses1");
  await until(() => recorded.some((r) => r.event.type === "error"));
  const err = recorded.find((r) => r.event.type === "error");
  assert.ok(err);
  assert.equal(err.event.type === "error" && err.event.text, "task failed: context too large for model");
});

test("/usage failure surfaces the typed code", async () => {
  reset();
  await onboard("!t10");
  failures.usage = { code: "usage-fetch-failed", details: "boom" };
  await run({ conversationId: "!t10", text: "/usage" });
  const err = recorded.find((r) => r.event.type === "error");
  assert.ok(err);
  assert.equal(err.event.type === "error" && err.event.text, "couldn't fetch usage: usage-fetch-failed — boom");
});

// ---------------------------------------------------------------------------
// Turn guardrails (separate runtime with aggressive caps) — the async turn's
// replacement for the old fixed POST deadline.
// ---------------------------------------------------------------------------

test("watchdog aborts a turn that goes silent and releases the room", async () => {
  reset();
  const runW = await guardrailOrchestrator({ turnWatchdogMs: 60 });
  await onboard("!g1", runW);
  await runW({ conversationId: "!g1", text: "long task" });
  await until(() => recorded.some((r) => r.event.type === "error" && r.event.text.includes("no activity")));
  assert.equal(calls.aborted, 1); // aborted server-side so it can't queue future turns
  await runW({ conversationId: "!g1", text: "retry" });
  assert.deepEqual(calls.sent, ["long task", "retry"]); // room released
  // Finish the retry turn — don't leak its watchdog into later tests.
  watchHandlers!.onIdle("ses1");
  await until(() => recorded.some((r) => r.event.type === "result"));
});

test("session error on the room's session ends the turn immediately, not after the watchdog", async () => {
  reset();
  const runW = await guardrailOrchestrator({ turnWatchdogMs: 60_000 }); // long enough that only the fix ends the turn early
  await onboard("!g1b", runW);
  await runW({ conversationId: "!g1b", text: "long task" });
  watchHandlers!.onSessionError({ sessionId: "ses1", message: "Aborted" });
  await until(() => recorded.some((r) => r.event.type === "error" && r.event.text.includes("Aborted")));
  assert.equal(calls.aborted, 0); // already ended server-side — nothing to abort
  await runW({ conversationId: "!g1b", text: "retry" }); // room released, not stuck busy
  assert.deepEqual(calls.sent, ["long task", "retry"]);
  watchHandlers!.onIdle("ses1");
  await until(() => recorded.some((r) => r.event.type === "result"));
});

test("a pending approval exempts the turn from the watchdog (human gate waits by design)", async () => {
  reset();
  const runW = await guardrailOrchestrator({ turnWatchdogMs: 60 });
  await onboard("!g2", runW);
  await runW({ conversationId: "!g2", text: "do the risky thing" });
  watchHandlers!.onPermission({ sessionId: "ses1", permissionId: "p9", description: "git push" });
  await until(() => recorded.some((r) => r.event.type === "approval-request"));
  await sleep(150); // > watchdog window — no abort while the approval is pending
  assert.equal(calls.aborted, 0);
  assert.equal(recorded.filter((r) => r.event.type === "error").length, 0);
  await runW({ conversationId: "!g2", text: "yes" });
  await until(() => calls.respond.length === 1);
  assert.deepEqual(calls.respond, [true]);
  // Approval resolved: the turn is guarded again — finish it cleanly.
  watchHandlers!.onIdle("ses1");
  await until(() => recorded.some((r) => r.event.type === "result"));
});

test("session-cost cap aborts a burning turn and tells the room", async () => {
  reset();
  const runC = await guardrailOrchestrator({ sessionCostCapUsd: 1 });
  await onboard("!g3", runC);
  await runC({ conversationId: "!g3", text: "loop forever" });
  watchHandlers!.onCostUpdate({ sessionId: "ses1", cost: 1.5 }); // >= cap (1)
  await until(() => recorded.some((r) => r.event.type === "error" && r.event.text.includes("cost reached")));
  assert.equal(calls.aborted, 1);
  // Fires once — further cost updates don't re-abort.
  watchHandlers!.onCostUpdate({ sessionId: "ses1", cost: 2.5 });
  await sleep(50);
  assert.equal(recorded.filter((r) => r.event.type === "error" && r.event.text.includes("cost reached")).length, 1);
});

test("duration cap aborts a turn that outlives the absolute budget", async () => {
  reset();
  const runD = await guardrailOrchestrator({ turnMaxMs: 200 });
  await onboard("!g4", runD);
  await runD({ conversationId: "!g4", text: "neverending story" });
  await until(() => recorded.some((r) => r.event.type === "error" && r.event.text.includes("duration guardrail")));
  assert.equal(calls.aborted, 1);
});

test("subagent sessions (foreign sessionIDs) don't finish or abort the room's turn", async () => {
  reset();
  const runW = await guardrailOrchestrator({ turnWatchdogMs: 60 });
  await onboard("!g5", runW);
  await runW({ conversationId: "!g5", text: "delegate some work" });
  watchHandlers!.onIdle("ses_subagent_42");
  watchHandlers!.onCostUpdate({ sessionId: "ses_subagent_42", cost: 99 });
  // Foreign events refresh the pod's activity clock — keep the watchdog fed
  // well past its window: nothing may finish or abort the room's turn.
  for (let i = 0; i < 5; i++) {
    await sleep(30);
    watchHandlers!.onProgress({ sessionId: "ses_subagent_42", title: "subagent step" });
  }
  assert.equal(calls.aborted, 0);
  assert.equal(recorded.filter((r) => r.event.type === "result" || r.event.type === "error").length, 0);
  // The room's own turn still completes normally afterwards.
  watchHandlers!.onIdle("ses1");
  await until(() => recorded.some((r) => r.event.type === "result"));
});

// ---------------------------------------------------------------------------
// Mention-gated shared rooms — the bot only acts when @-mentioned, but keeps
// unaddressed chatter as context for the next time it is addressed.
// ---------------------------------------------------------------------------

test("an unmentioned message is ambient: silent, no onboarding, no provisioning", async () => {
  reset();
  await run({ conversationId: "!a1", text: "hello everyone", mentioned: false, senderName: "Alice" });
  assert.equal(rooms.get("!a1"), undefined); // the gate runs before the room is even created
  assert.equal(recorded.length, 0);
  assert.equal(calls.provision.length, 0);
});

test("ambient chatter becomes context on the next addressed turn, which keeps the mention", async () => {
  reset();
  await onboard("!a2");
  await run({ conversationId: "!a2", text: "I think it's in auth.ts", mentioned: false, senderName: "Alice" });
  await run({ conversationId: "!a2", text: "agreed", mentioned: false, senderName: "Bob" });
  assert.equal(calls.sent.length, 0); // nothing fired while ambient

  await run({ conversationId: "!a2", text: "@Coding Agent fix it", senderName: "Alice" });
  assert.equal(calls.sent.length, 1);
  assert.ok(calls.sent[0].includes("Alice: I think it's in auth.ts"));
  assert.ok(calls.sent[0].includes("Bob: agreed"));
  assert.ok(calls.sent[0].includes("@Coding Agent fix it")); // raw text, mention preserved
});

test("the ambient transcript is capped at ~8000 chars (newest kept)", async () => {
  reset();
  await onboard("!a3");
  await run({ conversationId: "!a3", text: "x".repeat(20000), mentioned: false, senderName: "Alice" });
  await run({ conversationId: "!a3", text: "@Coding Agent go" });
  assert.equal(calls.sent.length, 1);
  assert.ok(calls.sent[0].length < 9000, `expected a clipped transcript, got ${calls.sent[0].length}`);
});

test("an unmentioned reply does not answer a pending approval; a mentioned one does", async () => {
  reset();
  await onboard("!a4");
  watchHandlers!.onPermission({ sessionId: "ses1", permissionId: "pa1", description: "git push" });
  await until(() => recorded.some((r) => r.event.type === "approval-request"));

  await run({ conversationId: "!a4", text: "yes", mentioned: false, senderName: "Bob" });
  assert.equal(calls.respond.length, 0); // ambient chatter must never decide

  await run({ conversationId: "!a4", text: "@Coding Agent yes", directive: "yes", senderName: "Alice" });
  assert.deepEqual(calls.respond, [true]);
});

test("a mentioned message while busy is declined and not fired", async () => {
  reset();
  await onboard("!a5");
  await run({ conversationId: "!a5", text: "@Coding Agent do X" });
  assert.deepEqual(calls.sent, ["@Coding Agent do X"]);
  await run({ conversationId: "!a5", text: "@Coding Agent also Y" });
  assert.ok(recorded.some((r) => r.event.type === "info" && r.event.text.includes("Still working")));
  assert.deepEqual(calls.sent, ["@Coding Agent do X"]);
  watchHandlers!.onIdle("ses1");
  await until(() => recorded.some((r) => r.event.type === "result"));
});

test("the mention is stripped for onboarding (directive) while raw text is preserved for the agent", async () => {
  reset();
  await run({ conversationId: "!a6", text: "@Coding Agent lab3ss/alveole", directive: "lab3ss/alveole" });
  assert.equal(rooms.get("!a6")?.repo, "lab3ss/alveole");
  assert.equal(rooms.get("!a6")?.onboarding, "token");
});

test("a tagged slash command is recognized once the mention is stripped", async () => {
  reset();
  await onboard("!a7");
  await run({ conversationId: "!a7", text: "@Coding Agent /usage", directive: "/usage" });
  assert.ok(recorded.some((r) => r.event.type === "usage"));
});
