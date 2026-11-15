/**
 * Coding agent — the self-contained bot. The broker imports ONLY this entry
 * point: it provides the platform's Agent service. The coding agent is the
 * opencode engine (harness/opencode) driven by the coding profile; everything
 * else (registry, runner image) is an implementation detail behind it.
 */
import { Layer } from "effect";
import { makeOpencodeAgent, type EngineConfig } from "../../harness/opencode/engine.ts";
import { Agent, type AgentBootOptions } from "../../platform/agent.ts";
import { codingConfigFromEnv } from "./config.ts";
import { codingProfile } from "./profile.ts";
import { RegistryLive } from "./registry-service.ts";
import { WorkspaceLive } from "../../harness/opencode/workspace.ts";

export { codingConfigFromEnv, type CodingConfig } from "./config.ts";

/** Builds the coding agent as the platform's Agent service. */
export const CodingAgentLive = (config: EngineConfig) => Layer.effect(Agent, makeOpencodeAgent(codingProfile, config));

/** The coding agent wired for the broker: engine + profile, its SQLite registry, the pod drivers. */
export const agentLayerFromEnv = (opts: AgentBootOptions) =>
  CodingAgentLive(codingConfigFromEnv()).pipe(
    Layer.provide(RegistryLive),
    Layer.provide(WorkspaceLive({ openrouterKey: opts.openrouterKey, agentName: opts.agentName })),
  );
