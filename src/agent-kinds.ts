/**
 * The one place agent kinds are known by name (AGENT_KIND). Each kind is loaded
 * with a dynamic import, never a static one: an agent's registry opens its
 * SQLite file at import time, so a process serving the assistant must not even
 * load the coding agent (it would open — and add coding columns to — the
 * assistant's database). Adding a kind = one line here plus its agents/<name>/
 * folder; the platform and the harness are untouched.
 */
import type { AgentModule } from "./platform/agent.ts";

const KINDS: Record<string, () => Promise<AgentModule>> = {
  coding: () => import("./agents/coding/index.ts"),
  assistant: () => import("./agents/assistant/index.ts"),
};

export const agentKinds = (): string[] => Object.keys(KINDS);

export async function loadAgentModule(kind: string): Promise<AgentModule> {
  if (!Object.hasOwn(KINDS, kind)) {
    throw new Error(`unknown AGENT_KIND "${kind}" — expected one of: ${agentKinds().join(", ")}`);
  }
  return KINDS[kind]();
}

/**
 * The name that prefixes this bot's workspace resources (pods, networks, env
 * files). Unset for the original coding agent, so rooms already live under its
 * historical names keep working. Every other bot MUST name itself: two bots in
 * one room with the same name would fight over the same containers, and a
 * silent default (the kind) would do exactly that for two assistant bots.
 */
export function resolveAgentName(kind: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = env.AGENT_NAME?.trim() || undefined;
  if (kind !== "coding" && !name) {
    throw new Error(
      `AGENT_NAME required for AGENT_KIND=${kind} — it names this bot's workspaces and must differ between bots sharing a room (e.g. AGENT_NAME=<bot-name>)`,
    );
  }
  return name;
}
