/**
 * Coding agent — the self-contained bot. The broker imports ONLY this entry
 * point: it provides the platform's Agent service and exposes the persona
 * rules the composition root wires into the Matrix adapter. Everything else
 * (orchestrator, registry, workspace drivers, runner) is an implementation
 * detail behind it.
 */
import { Layer } from "effect";
import { Agent } from "../../platform/agent.ts";
import { makeCodingAgent, type OrchestratorConfig } from "./orchestrator.ts";

export { Orchestrator, OrchestratorLive, makeCodingAgent, type OrchestratorConfig, type OrchestratorService } from "./orchestrator.ts";
export { codingConfigFromEnv, type CodingConfig } from "./config.ts";
export { codingAgentRules } from "./rules.ts";
export { RegistryLive } from "./registry-service.ts";
export { WorkspaceLive } from "./workspace.ts";

/** Builds the coding agent as the platform's Agent service. */
export const CodingAgentLive = (config: OrchestratorConfig) => Layer.effect(Agent, makeCodingAgent(config));
