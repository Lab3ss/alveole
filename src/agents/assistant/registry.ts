/**
 * Assistant registry — the harness's base room (model + pod/session pointers)
 * and nothing else: there is no onboarding, repo or token to remember. Persists
 * across restarts so a room keeps its model override; the workspace itself is
 * disposable.
 */
import { createBaseRegistry, openRegistryDb } from "../../platform/registry.ts";
import { harnessColumns, type HarnessRoom } from "../../harness/opencode/registry.ts";

export type Room = HarnessRoom;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const base = createBaseRegistry<Room>({
  db: openRegistryDb(),
  columns: harnessColumns,
  create: (roomId) => ({ roomId, lastActivity: Date.now() }),
  hydrate: (row) => ({
    roomId: String(row.room_id),
    model: str(row.model),
    podName: str(row.pod_name),
    sessionId: str(row.session_id),
    lastActivity: Number(row.last_activity),
  }),
});

export const getRoom = base.get;
export const newRoom = base.create;
export const saveRoom = base.save;
export const touch = base.touch;
export const deleteRoom = base.remove;

/** Rooms with a live pod that have been idle longer than `maxIdleMs`. */
export function idleRooms(maxIdleMs: number): Room[] {
  return base.idle(maxIdleMs).filter((r) => r.podName);
}
