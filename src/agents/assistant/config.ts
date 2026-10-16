/**
 * Assistant configuration — environment → engine config + profile settings.
 * The composition root (broker.ts) calls this; no platform code reads these env
 * vars. Several bots (Haiku, Le Chat, …) are the same agent with a different
 * ASSISTANT_DEFAULT_MODEL and Matrix account — model is the only difference.
 */
import type { EngineConfig } from "../../harness/opencode/engine.ts";

export type AssistantSettings = {
  /** Replaces the default persona when set (ASSISTANT_SYSTEM_PROMPT). */
  readonly systemPrompt?: string;
  /** Runner image for this bot's containers. */
  readonly runnerImage: string;
  /** Hours of idleness before the disposable workspace is torn down — named in the greeting. */
  readonly idleHours: number;
};

export type AssistantConfig = { readonly engine: EngineConfig; readonly settings: AssistantSettings };

/** Same defaults as the coding runner's drivers: a published tag on k8s, a locally built one on compose. */
const defaultRunnerImage = (backend: string | undefined): string =>
  backend === "compose" ? "alveole-assistant-runner:local" : "ghcr.io/lab3ss/alveole-assistant-runner:0.3.0";

export function assistantConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
  const idleHours = parseFloat(env.IDLE_TEARDOWN_HOURS ?? "24");
  return {
    engine: {
      idleTeardownMs: idleHours * 3600_000,
      sweepIntervalMs: 15 * 60_000,
      // Same turn guardrails as every pod-backed agent; 0 disables (except the
      // cost cap, where 0 means "free").
      turnWatchdogMs: parseFloat(env.TURN_WATCHDOG_MINUTES ?? "15") * 60_000,
      turnMaxMs: parseFloat(env.TURN_MAX_HOURS ?? "4") * 3600_000,
      sessionCostCapUsd: parseFloat(env.SESSION_COST_CAP_USD ?? "10"),
      // `~anthropic/claude-haiku-latest` is OpenRouter's floating alias for the
      // newest Haiku; pin an exact slug here to stop it moving.
      defaultModel: env.ASSISTANT_DEFAULT_MODEL ?? "~anthropic/claude-haiku-latest",
    },
    settings: {
      systemPrompt: env.ASSISTANT_SYSTEM_PROMPT || undefined,
      runnerImage: env.ASSISTANT_RUNNER_IMAGE || defaultRunnerImage(env.WORKSPACE_BACKEND),
      idleHours,
    },
  };
}
