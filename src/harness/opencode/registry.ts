/**
 * Registry shape the opencode engine needs from any agent: the platform's base
 * room plus the live-workspace pointer (pod + opencode session). An agent's own
 * registry extends this with its columns; the engine never sees them.
 *
 * Behind an Effect service so the engine (and its tests) run against the real
 * SQLite registry or an in-memory fake without knowing which. Method bodies
 * are sync (node:sqlite) and never fail at the type level.
 */
import { Context } from "effect";
import type { BaseRoom, RoomColumn } from "../../platform/registry.ts";

export type HarnessRoom = BaseRoom & {
  podName?: string; // set only while a pod is live
  sessionId?: string; // opencode session id; cleared when the pod is torn down
};

/** The columns every harness room persists, shared by all agents' registries. */
export const harnessColumns: readonly RoomColumn<HarnessRoom>[] = [
  { column: "pod_name", type: "TEXT", write: (r) => r.podName },
  { column: "session_id", type: "TEXT", write: (r) => r.sessionId },
];

export interface RegistryService<R extends HarnessRoom = HarnessRoom> {
  readonly get: (conversationId: string) => R | undefined;
  /** Creates the room in the agent's initial state (e.g. coding starts onboarding). */
  readonly create: (conversationId: string) => R;
  readonly save: (room: R) => void;
  readonly touch: (conversationId: string) => void;
  /** Rooms with a live pod idle longer than maxIdleMs. */
  readonly idle: (maxIdleMs: number) => R[];
  /** Purges a conversation entirely — only safe when nobody can come back to it. */
  readonly delete: (conversationId: string) => void;
}

export class Registry extends Context.Tag("alveole/Registry")<Registry, RegistryService>() {}
