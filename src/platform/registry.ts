/**
 * Platform registry primitives — the agent-agnostic half of the persistent
 * per-room registry. An agent's registry extends this with its own columns
 * while the DB file, the base `rooms` table, and the additive-migration helper
 * stay here.
 *
 * The table schema is deliberately stable: platform creates the base columns,
 * then each agent adds its own columns idempotently (addColumnIfMissing), so a
 * registry.db written by an older build keeps working untouched.
 */
import { DatabaseSync } from "node:sqlite";

/** The columns every agent's room has: an opaque conversation id, an optional
 * model, and the last-activity clock the idle sweep reads. */
export type BaseRoom = {
  roomId: string;
  model?: string;
  lastActivity: number; // epoch ms
};

/** An agent-specific column, mapped to/from a room field. */
export type RoomColumn<Row extends BaseRoom> = {
  readonly column: string;
  readonly type: string;
  readonly write: (room: Row) => string | number | null | undefined;
};

export interface BaseRegistry<Row extends BaseRoom> {
  readonly all: () => Row[];
  readonly get: (roomId: string) => Row | undefined;
  readonly create: (roomId: string) => Row;
  readonly save: (room: Row) => void;
  readonly touch: (roomId: string) => void;
  readonly remove: (roomId: string) => void;
  /** Rooms idle longer than maxIdleMs (the caller filters live-resource eligibility). */
  readonly idle: (maxIdleMs: number) => Row[];
}

/** Opens the registry DB. The base `rooms` table is created if absent; an
 * existing table is left untouched (columns are added by the agent). */
export function openRegistryDb(dbPath = process.env.REGISTRY_DB_PATH ?? "registry.db"): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE IF NOT EXISTS rooms (
       room_id TEXT PRIMARY KEY, model TEXT, last_activity INTEGER NOT NULL
     )`,
  );
  return db;
}

/** Idempotent ADD COLUMN — replaces the per-column try/catch ALTER TABLE loops.
 * A duplicate-column error on a DB that already has it is expected and ignored. */
export function addColumnIfMissing(db: DatabaseSync, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE rooms ADD COLUMN ${column} ${type}`);
  } catch {
    // column already exists (CREATE TABLE IF NOT EXISTS left the old table alone)
  }
}

/**
 * Wires an agent's columns onto the base table and returns in-memory CRUD over
 * it. `hydrate` reads a full SQL row (base + agent columns) into a room;
 * `create` builds a fresh row (id + onboarding defaults) the first time a room
 * is seen.
 */
export function createBaseRegistry<Row extends BaseRoom>(opts: {
  readonly db: DatabaseSync;
  readonly columns: readonly RoomColumn<Row>[];
  readonly create: (roomId: string) => Row;
  readonly hydrate: (row: Record<string, unknown>) => Row;
}): BaseRegistry<Row> {
  const { db, columns } = opts;
  for (const c of columns) addColumnIfMissing(db, c.column, c.type);

  const allColumns = ["room_id", "model", "last_activity", ...columns.map((c) => c.column)];
  const placeholders = allColumns.map(() => "?").join(", ");
  const updateSet = allColumns
    .filter((c) => c !== "room_id")
    .map((c) => `${c}=excluded.${c}`)
    .join(", ");
  const insert = db.prepare(
    `INSERT INTO rooms (${allColumns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT(room_id) DO UPDATE SET ${updateSet}`,
  );

  const rooms = new Map<string, Row>();
  for (const row of db.prepare(`SELECT * FROM rooms`).all() as Record<string, unknown>[]) {
    rooms.set(String(row.room_id), opts.hydrate(row));
  }

  const persist = (r: Row): void => {
    const values = [r.roomId, r.model ?? null, r.lastActivity, ...columns.map((c) => c.write(r) ?? null)];
    insert.run(...(values as Array<string | number | null>));
  };

  return {
    all: () => [...rooms.values()],
    get: (roomId) => rooms.get(roomId),
    create: (roomId) => {
      const r = opts.create(roomId);
      rooms.set(roomId, r);
      persist(r);
      return r;
    },
    save: (r) => {
      rooms.set(r.roomId, r);
      persist(r);
    },
    touch: (roomId) => {
      const r = rooms.get(roomId);
      if (r) {
        r.lastActivity = Date.now();
        persist(r);
      }
    },
    remove: (roomId) => {
      rooms.delete(roomId);
      db.prepare(`DELETE FROM rooms WHERE room_id = ?`).run(roomId);
    },
    idle: (maxIdleMs) => {
      const cutoff = Date.now() - maxIdleMs;
      return [...rooms.values()].filter((r) => r.lastActivity < cutoff);
    },
  };
}
