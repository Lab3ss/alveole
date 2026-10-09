/**
 * Broker entry point — composition root only.
 *
 * Everything the broker does now lives in two places:
 *   - src/platform/ — the shared layer: Matrix transport, room gating, boot,
 *     the registry primitives, the Agent interface and start wiring
 *   - src/agents/   — self-contained agents; today only the coding agent
 *
 * This file resolves boot credentials, picks an agent, builds the layers,
 * wires the adapter, and starts. Adding an agent means adding an
 * agents/<name>/ folder and changing the one line that picks it here — never
 * copying the orchestrator or editing platform code.
 *
 * Requires: MATRIX_HOMESERVER, MATRIX_TOKEN (this bot's account),
 * OPENROUTER_API_KEY (the one and only LLM credential, shared into every
 * room's pod at provision time — never stored per-room in Git).
 *
 * Optional: MATRIX_E2EE (default true — decrypt/encrypt encrypted rooms via a
 * Rust crypto store, kept next to the registry DB) and MATRIX_CRYPTO_STORE
 * (override that directory).
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { CodingAgentLive, RegistryLive, WorkspaceLive, codingAgentRules, codingConfigFromEnv } from "./agents/coding/index.ts";
import { MatrixAdapterLive } from "./platform/adapter/matrix.ts";
import { Agent, startAgent } from "./platform/agent.ts";
import { cryptoStorePath, resolveMatrixCredentials } from "./platform/boot.ts";

const { homeserver, token } = await resolveMatrixCredentials();

const openrouterKey = process.env.OPENROUTER_API_KEY;
if (!openrouterKey) throw new Error("OPENROUTER_API_KEY required");

const cryptoStoragePath = cryptoStorePath();
const codingConfig = codingConfigFromEnv();

// The one place an agent is chosen. A second agent is a new agents/<name>/
// folder and a different Live layer here; the platform is untouched.
const AdapterLive = MatrixAdapterLive({
  homeserver,
  token,
  storagePath: "bot-state.json",
  cryptoStoragePath,
  agentRules: codingAgentRules,
});

const AgentLayer = CodingAgentLive(codingConfig).pipe(
  Layer.provide(RegistryLive),
  Layer.provide(WorkspaceLive({ openrouterKey })),
  Layer.provide(AdapterLive),
);

// The adapter is exposed alongside the agent so the composition root can hand
// it to startAgent (which reads ChatAdapter from context). Effect memoizes the
// shared AdapterLive, so there is exactly one Matrix client.
const runtime = ManagedRuntime.make(Layer.merge(AgentLayer, AdapterLive));

await runtime
  .runPromise(
    Effect.gen(function* () {
      const agent = yield* Agent;
      yield* startAgent(agent); // hooks the adapter's inbound stream
    }),
  )
  // The only failure this effect can produce is the adapter's stable
  // "chat-start-failed" code (raw cause already logged by the adapter) — boot
  // reports the code and exits; there is no broker without a chat transport.
  .catch((code: "chat-start-failed") => {
    console.error(`[alveole] startup failed: ${code} (details above)`);
    process.exit(1);
  });

console.log("[alveole] listening. Invite me to a room to onboard a project.");
