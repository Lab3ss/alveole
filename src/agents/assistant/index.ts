/**
 * Assistant agent — the self-contained general-purpose bot. The broker imports
 * ONLY this entry point: it provides the platform's Agent service. The
 * assistant is the opencode engine (harness/opencode) driven by the assistant
 * profile; everything else (registry, runner image) is an implementation
 * detail behind it.
 */
import { Layer } from "effect";
import { makeOpencodeAgent } from "../../harness/opencode/engine.ts";
import { Agent, type AgentBootOptions } from "../../platform/agent.ts";
import { assistantConfigFromEnv, type AssistantConfig } from "./config.ts";
import { assistantProfile } from "./profile.ts";
import { RegistryLive } from "./registry-service.ts";
import { WorkspaceLive } from "../../harness/opencode/workspace.ts";

export { assistantConfigFromEnv, type AssistantConfig } from "./config.ts";

/** Builds the assistant as the platform's Agent service. */
export const AssistantAgentLive = (config: AssistantConfig) =>
  Layer.effect(Agent, makeOpencodeAgent(assistantProfile(config.settings), config.engine));

/** The assistant wired for the broker: engine + profile, its SQLite registry, the pod drivers. */
export const agentLayerFromEnv = (opts: AgentBootOptions) =>
  AssistantAgentLive(assistantConfigFromEnv()).pipe(
    Layer.provide(RegistryLive),
    Layer.provide(WorkspaceLive({ openrouterKey: opts.openrouterKey, agentName: opts.agentName })),
  );
