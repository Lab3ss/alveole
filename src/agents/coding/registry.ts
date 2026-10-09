/**
 * Coding-agent registry — the coding columns (repo/token/onboarding/git
 * identity/pod/session) on top of the platform's registry primitives. Persists
 * across restarts so a room re-provisions without re-asking onboarding
 * questions, even after its pod is torn down.
 */
import { createBaseRegistry, openRegistryDb, type BaseRoom, type RoomColumn } from "../../platform/registry.ts";

export type OnboardingStep = "repo" | "token";
export type Room = BaseRoom & {
  roomId: string;
  onboarding?: OnboardingStep; // unset once the repo+token are in (model has a default)
  repo?: string;
  token?: string;
  /** Per-room git commit identity override (`/git-name`, `/git-email`). When
   * unset, the runner derives it from the room's GitHub token at boot. */
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  podName?: string; // set only while a pod is live
  sessionId?: string; // opencode session id; cleared when the pod is torn down
  lastActivity: number; // epoch ms
};

const columns: readonly RoomColumn<Room>[] = [
  { column: "onboarding", type: "TEXT", write: (r) => r.onboarding },
  { column: "repo", type: "TEXT", write: (r) => r.repo },
  { column: "token", type: "TEXT", write: (r) => r.token },
  { column: "git_author_name", type: "TEXT", write: (r) => r.gitAuthorName },
  { column: "git_author_email", type: "TEXT", write: (r) => r.gitAuthorEmail },
  { column: "pod_name", type: "TEXT", write: (r) => r.podName },
  { column: "session_id", type: "TEXT", write: (r) => r.sessionId },
];

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function hydrate(row: Record<string, unknown>): Room {
  // Legacy rows could be parked on the removed "model" step (pre-default-model
  // flow): treat them as fully onboarded — the orchestrator supplies the
  // default model when it next runs a task.
  const onboarding = row.onboarding === "repo" || row.onboarding === "token" ? (row.onboarding as OnboardingStep) : undefined;
  return {
    roomId: String(row.room_id),
    onboarding,
    repo: str(row.repo),
    token: str(row.token),
    model: str(row.model),
    gitAuthorName: str(row.git_author_name),
    gitAuthorEmail: str(row.git_author_email),
    podName: str(row.pod_name),
    sessionId: str(row.session_id),
    lastActivity: Number(row.last_activity),
  };
}

const base = createBaseRegistry<Room>({
  db: openRegistryDb(),
  columns,
  create: (roomId) => ({ roomId, onboarding: "repo", lastActivity: Date.now() }),
  hydrate,
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
