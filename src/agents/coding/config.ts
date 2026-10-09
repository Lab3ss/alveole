/**
 * Coding-agent configuration — environment → OrchestratorConfig. The
 * composition root (broker.ts) calls this; no platform code reads these env
 * vars.
 */
import type { OrchestratorConfig } from "./orchestrator.ts";

export type CodingConfig = OrchestratorConfig;

export function codingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  return {
    idleTeardownMs: parseFloat(env.IDLE_TEARDOWN_HOURS ?? "24") * 3600_000,
    sweepIntervalMs: 15 * 60_000,
    // Turn guardrails (async turn): inactivity watchdog, absolute duration cap,
    // session-cost circuit-breaker. All three abort the turn server-side and
    // tell the room; 0 disables (except the cost cap, where 0 means "free").
    turnWatchdogMs: parseFloat(env.TURN_WATCHDOG_MINUTES ?? "15") * 60_000,
    turnMaxMs: parseFloat(env.TURN_MAX_HOURS ?? "4") * 3600_000,
    sessionCostCapUsd: parseFloat(env.SESSION_COST_CAP_USD ?? "10"),
    // Every newly onboarded room starts on this OpenRouter model; a user can
    // override it per room with /model. See .env.example.
    defaultModel: env.DEFAULT_CODING_AGENT_MODEL ?? "deepseek/deepseek-v4.1-flash",
  };
}
