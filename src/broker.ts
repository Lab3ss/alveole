/**
 * Broker entry point — composition root only.
 *
 * Everything the broker does lives in two places now:
 *   - src/core/   — the transport-neutral orchestrator (onboarding, commands,
 *     approvals, provisioning, retries, teardown) behind Effect services
 *   - src/adapter/ — chat transports (Matrix today) implementing ChatAdapter
 *
 * This file validates env, builds the Effect layers, wires the adapter's
 * inbound stream into the orchestrator, and starts. A second chat platform is
 * a new adapter + a different layer here — no core changes.
 *
 * Requires: MATRIX_HOMESERVER, MATRIX_TOKEN (this bot's account),
 * OPENROUTER_API_KEY (the one and only LLM credential, shared into every
 * room's pod at provision time — never stored per-room in Git).
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { readFile } from "node:fs/promises";
import { MatrixAdapterLive } from "./adapter/matrix.ts";
import { Orchestrator, OrchestratorLive } from "./core/orchestrator.ts";
import { RegistryLive } from "./core/registry-service.ts";
import { WorkspaceLive } from "./core/workspace.ts";

let homeserver = process.env.MATRIX_HOMESERVER!;
let matrixToken = process.env.MATRIX_TOKEN!;
const openrouterKey = process.env.OPENROUTER_API_KEY!;

// External-Matrix deployments provide MATRIX_HOMESERVER/MATRIX_TOKEN directly.
// In compose mode the bundled homeserver's bootstrap (deploy/bootstrap) creates
// the bot account instead and writes its credentials to /data/bot-account.json
// — the broker picks them up here, waiting up to 120s (2s retries) since it
// deliberately has no depends_on on the bootstrap (see deploy/docker-compose.yml).
if (!homeserver || !matrixToken) {
  const deadline = Date.now() + (process.env.WORKSPACE_BACKEND === "compose" ? 120_000 : 0);
  if (deadline) console.log("[alveole] MATRIX_TOKEN absent — waiting for /data/bot-account.json (bundled bootstrap)…");
  do {
    try {
      const acct = JSON.parse(await readFile("/data/bot-account.json", "utf8")) as { homeserverUrl?: string; botAccessToken?: string };
      // The bootstrap writes a coherent pair — take both or neither. Mixing a
      // half-set env var with the file sends the local bot's token to a
      // foreign homeserver (M_MISSING_TOKEN at startup).
      if (acct.homeserverUrl && acct.botAccessToken) {
        homeserver = acct.homeserverUrl;
        matrixToken = acct.botAccessToken;
        break;
      }
      homeserver = homeserver || acct.homeserverUrl || "";
      matrixToken = matrixToken || acct.botAccessToken || "";
      if (homeserver && matrixToken) break;
    } catch {
      // not written yet (bootstrap still running) or a partial write
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 2000));
  } while (true);
}

if (!homeserver || !matrixToken) {
  if (process.env.WORKSPACE_BACKEND === "compose") {
    throw new Error("no usable /data/bot-account.json within 120s — the bootstrap didn't produce the bot's credentials; check `docker compose -f deploy/docker-compose.yml --env-file .env logs bootstrap` and the homeserver container's logs");
  }
  throw new Error("MATRIX_HOMESERVER and MATRIX_TOKEN required (compose mode reads them from /data/bot-account.json, written by deploy/bootstrap)");
}
if (!openrouterKey) throw new Error("OPENROUTER_API_KEY required");

const orchestratorConfig = {
  idleTeardownMs: parseFloat(process.env.IDLE_TEARDOWN_HOURS ?? "24") * 3600_000,
  sweepIntervalMs: 15 * 60_000,
  // Turn guardrails (async turn): inactivity watchdog, absolute duration cap,
  // session-cost circuit-breaker. All three abort the turn server-side and
  // tell the room; 0 disables (except the cost cap, where 0 means "free").
  turnWatchdogMs: parseFloat(process.env.TURN_WATCHDOG_MINUTES ?? "15") * 60_000,
  turnMaxMs: parseFloat(process.env.TURN_MAX_HOURS ?? "4") * 3600_000,
  sessionCostCapUsd: parseFloat(process.env.SESSION_COST_CAP_USD ?? "10"),
};

const AppLayer = OrchestratorLive(orchestratorConfig).pipe(
  Layer.provide(RegistryLive),
  Layer.provide(WorkspaceLive({ openrouterKey })),
  Layer.provide(MatrixAdapterLive({ homeserver, token: matrixToken, storagePath: "bot-state.json" })),
);

const runtime = ManagedRuntime.make(AppLayer);

// The only failure this effect can produce is the adapter's stable
// "chat-start-failed" code (raw cause already logged by the adapter) — boot
// reports the code and exits; there is no broker without a chat transport.
await runtime.runPromise(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    yield* orchestrator.start; // hooks the adapter's inbound stream + idle sweep
  }),
).catch((code: "chat-start-failed") => {
  console.error(`[alveole] startup failed: ${code} (details above)`);
  process.exit(1);
});

console.log("[alveole] listening. Invite me to a room to onboard a project.");
