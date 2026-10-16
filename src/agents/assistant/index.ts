/**
 * Assistant agent — the self-contained general-purpose bot. The broker imports
 * ONLY this entry point: it provides the platform's Agent service. The
 * assistant is the opencode engine (harness/opencode) driven by the assistant
 * profile; everything else (registry, runner image) is an implementation
 * detail behind it.
 */
import { Layer } from "effect";
import { makeOpencodeAgent } from "../../harness/opencode/engine.ts";
import { Agent } from "../../platform/agent.ts";
import type { AssistantConfig } from "./config.ts";
import { assistantProfile } from "./profile.ts";

export { assistantConfigFromEnv, type AssistantConfig } from "./config.ts";
export { RegistryLive } from "./registry-service.ts";
export { WorkspaceLive } from "../../harness/opencode/workspace.ts";

/** Builds the assistant as the platform's Agent service. */
export const AssistantAgentLive = (config: AssistantConfig) =>
  Layer.effect(Agent, makeOpencodeAgent(assistantProfile(config.settings), config.engine));
