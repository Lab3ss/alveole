/**
 * Broker entry point — composition root only.
 *
 * Everything the broker does lives in three places:
 *   - src/platform/ — the shared layer: Matrix transport, room gating, boot,
 *     the registry primitives, the Agent interface and start wiring
 *   - src/harness/opencode/ — the pod engine shared by pod-backed agents:
 *     workspace drivers, the opencode client, and the turn lifecycle, driven
 *     by an agent's Profile
 *   - src/agents/   — self-contained agents: coding, assistant
 *
 * This file picks the agent (AGENT_KIND, see agent-kinds.ts), resolves boot
 * credentials, builds the layers, wires the adapter, and starts. Adding an agent
 * means adding an agents/<name>/ folder and one line in agent-kinds.ts — never
 * copying the engine or editing platform code.
 *
 * Requires: MATRIX_HOMESERVER, MATRIX_TOKEN (this bot's account),
 * OPENROUTER_API_KEY (the one and only LLM credential, shared into every
 * room's pod at provision time — never stored per-room in Git).
 *
 * Optional: AGENT_KIND (coding|assistant, default coding), AGENT_NAME (required
 * for every kind but coding — names this bot's workspaces), BOT_ACCOUNT_FILE
 * (this bot's bootstrap-written Matrix account), MATRIX_E2EE (default true —
 * decrypt/encrypt encrypted rooms via a Rust crypto store, kept next to the
 * registry DB) and MATRIX_CRYPTO_STORE (override that directory).
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { loadAgentModule, resolveAgentName } from "./agent-kinds.ts";
import { MatrixAdapterLive } from "./platform/adapter/matrix.ts";
import { Agent, startAgent } from "./platform/agent.ts";
import { botStatePath, cryptoStorePath, resolveMatrixCredentials } from "./platform/boot.ts";

// Which agent this process serves (default: the coding agent). Resolved first so
// a bad AGENT_KIND / missing AGENT_NAME fails before any Matrix traffic.
const kind = process.env.AGENT_KIND ?? "coding";
const agentName = resolveAgentName(kind);
const agentModule = await loadAgentModule(kind);

const { homeserver, token } = await resolveMatrixCredentials();

const openrouterKey = process.env.OPENROUTER_API_KEY;
if (!openrouterKey) throw new Error("OPENROUTER_API_KEY required");

const cryptoStoragePath = cryptoStorePath();

const AdapterLive = MatrixAdapterLive({
  homeserver,
  token,
  storagePath: botStatePath(),
  cryptoStoragePath,
});

// provideMerge: the one Matrix client is built once and exposed next to the
// agent, so startAgent (which reads ChatAdapter from context) shares it.
const AgentLayer = agentModule.agentLayerFromEnv({ openrouterKey, agentName }).pipe(Layer.provideMerge(AdapterLive));

const runtime = ManagedRuntime.make(AgentLayer);

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

console.log(`[alveole] ${kind} agent listening${agentName ? ` as "${agentName}"` : ""}. Invite me to a room.`);
