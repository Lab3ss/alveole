/**
 * Coding agent — the self-contained bot. The broker imports ONLY this entry
 * point: it provides the platform's Agent service. The coding agent is the
 * opencode engine (harness/opencode) driven by the coding profile; everything
 * else (registry, runner image) is an implementation detail behind it.
 */
import { Layer } from "effect";
import { makeOpencodeAgent, type EngineConfig } from "../../harness/opencode/engine.ts";
import { Agent } from "../../platform/agent.ts";
import { codingProfile } from "./profile.ts";

export { codingConfigFromEnv, type CodingConfig } from "./config.ts";
export { RegistryLive } from "./registry-service.ts";
export { WorkspaceLive } from "../../harness/opencode/workspace.ts";

/** Builds the coding agent as the platform's Agent service. */
export const CodingAgentLive = (config: EngineConfig) => Layer.effect(Agent, makeOpencodeAgent(codingProfile, config));
