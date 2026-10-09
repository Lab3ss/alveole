/**
 * Coding agent — the self-contained bot. The broker imports ONLY this entry
 * point: it provides the platform's Agent service. Everything else
 * (orchestrator, registry, workspace drivers, runner) is an implementation
 * detail behind it.
 */
import { Layer } from "effect";
import { Agent } from "../../platform/agent.ts";
import { makeCodingAgent, type OrchestratorConfig } from "./orchestrator.ts";

export { makeCodingAgent, type OrchestratorConfig } from "./orchestrator.ts";
export { codingConfigFromEnv, type CodingConfig } from "./config.ts";
export { RegistryLive } from "./registry-service.ts";
export { WorkspaceLive } from "./workspace.ts";

/** Builds the coding agent as the platform's Agent service. */
export const CodingAgentLive = (config: OrchestratorConfig) => Layer.effect(Agent, makeCodingAgent(config));
