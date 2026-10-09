import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The registry opens its SQLite file at import time — point it at a throwaway
// file before importing. node --test runs each test file in its own process,
// so this env var can't leak into other suites.
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "registry-test-")), "registry.db");
process.env.REGISTRY_DB_PATH = dbPath;

const { newRoom, getRoom, saveRoom, touch, idleRooms } = await import("../../../src/agents/coding/registry.ts");
const { DatabaseSync } = await import("node:sqlite");

test("newRoom starts onboarding at the repo step and persists", () => {
  const r = newRoom("!r1:example.org");
  assert.equal(r.onboarding, "repo");
  assert.equal(getRoom("!r1:example.org")?.onboarding, "repo");
});

test("saveRoom persists the full row (what a broker restart relies on)", () => {
  const r = getRoom("!r1:example.org")!;
  r.repo = "lab3ss/alveole";
  r.token = "ghp_testtoken123456";
  r.model = "anthropic/claude-sonnet-4.5";
  r.podName = "room-dev-abc";
  r.sessionId = "ses_123";
  saveRoom(r);

  // Read back through a fresh SQLite handle, i.e. what a restarted broker's
  // registry import would load.
  const db = new DatabaseSync(dbPath);
  const row: any = db.prepare(`SELECT * FROM rooms WHERE room_id = ?`).get("!r1:example.org");
  db.close();
  assert.equal(row.repo, "lab3ss/alveole");
  assert.equal(row.token, "ghp_testtoken123456");
  assert.equal(row.model, "anthropic/claude-sonnet-4.5");
  assert.equal(row.pod_name, "room-dev-abc");
  assert.equal(row.session_id, "ses_123");
});

test("touch bumps lastActivity and idleRooms respects it", async () => {
  const r = getRoom("!r1:example.org")!;
  r.lastActivity = Date.now() - 10 * 3600_000;
  saveRoom(r);
  assert.deepEqual(idleRooms(24 * 3600_000), []);
  assert.ok(idleRooms(9 * 3600_000).some((x) => x.roomId === "!r1:example.org"));
  touch("!r1:example.org");
  assert.deepEqual(idleRooms(9 * 3600_000), []);
});

test("idleRooms only considers rooms with a live pod", () => {
  const r = getRoom("!r1:example.org")!;
  r.podName = undefined;
  saveRoom(r);
  assert.deepEqual(idleRooms(0), []);
});

test("a registry.db written by the pre-split build loads and keeps working (AC-3)", async () => {
  const legacyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "registry-legacy-")), "registry.db");
  const legacy = new DatabaseSync(legacyPath);
  // The exact table shape the old src/registry.ts created, before the git-identity columns.
  legacy.exec(
    `CREATE TABLE rooms (
       room_id TEXT PRIMARY KEY, onboarding TEXT, repo TEXT, token TEXT, model TEXT,
       pod_name TEXT, session_id TEXT, last_activity INTEGER NOT NULL
     )`,
  );
  legacy
    .prepare(`INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("!old:example.org", "model", "lab3ss/alveole", "ghp_legacytoken1234", "some/model", "room-old", "ses_old", 1_000);
  legacy.close();

  // Fresh process: the registry opens its DB at import time.
  const { execFileSync } = await import("node:child_process");
  const script = `
    const { getRoom, saveRoom } = await import(${JSON.stringify(path.resolve("src/agents/coding/registry.ts"))});
    const r = getRoom("!old:example.org");
    const out = { onboarding: r.onboarding ?? null, repo: r.repo, model: r.model, podName: r.podName, last: r.lastActivity };
    r.gitAuthorName = "Ada";
    saveRoom(r);
    console.log(JSON.stringify(out));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, REGISTRY_DB_PATH: legacyPath },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(out.trim().split("\n").pop()!), {
    onboarding: null, // legacy "model" step → treated as fully onboarded
    repo: "lab3ss/alveole",
    model: "some/model",
    podName: "room-old",
    last: 1000,
  });
  const db = new DatabaseSync(legacyPath);
  const row: any = db.prepare(`SELECT * FROM rooms WHERE room_id = ?`).get("!old:example.org");
  const cols = (db.prepare(`PRAGMA table_info(rooms)`).all() as any[]).map((c) => c.name);
  db.close();
  assert.equal(row.git_author_name, "Ada"); // new column added in place and writable
  assert.equal(new Set(cols).size, cols.length); // no duplicated columns
});
