/**
 * End-to-end tests of deploy/bootstrap/bootstrap.mjs against a mock Matrix
 * homeserver: UIAA token registration (401 dance), login, room creation, the
 * atomic 0600 account file, idempotent re-runs (reuse, no duplicate room), and
 * self-healing after a homeserver reset (stale file → accounts/room recreated).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const DOMAIN = "localhost:8008";
const usernameOf = (userId: string) => userId.replace(/^@/, "").split(":")[0];

interface Mock {
  server: Server;
  url: string;
  registered: Map<string, string>;
  createRoomCount: () => number;
  whoamiCount: () => number;
  roomNames: () => string[];
  roomNameOf: (roomId: string) => string | undefined;
  messages: () => Array<{ roomId: string; body: string }>;
  displayNames: () => Map<string, string>;
}

/** A minimal in-memory homeserver good enough for the bootstrap's flow. */
async function startMockHomeserver(
  opts: { token?: string; accounts?: Record<string, string> } = {},
): Promise<Mock> {
  const token = opts.token ?? "it-token";
  const registered = new Map<string, string>(Object.entries(opts.accounts ?? {}));
  const tokens = new Map<string, string>(); // access token -> user id
  const rooms = new Map<string, Set<string>>(); // room id -> members
  const roomNames: string[] = [];
  const roomNamesById = new Map<string, string>();
  const sentMessages: Array<{ roomId: string; body: string }> = [];
  const displayNames = new Map<string, string>();
  let tokenSeq = 0;
  let roomSeq = 0;
  let creates = 0;
  let whoamis = 0;

  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? "/", "http://x");
      const userId = (() => {
        const auth = req.headers.authorization;
        return typeof auth === "string" ? tokens.get(auth.replace(/^Bearer /, "")) : undefined;
      })();

      if (url.pathname === "/_matrix/client/versions") return reply(200, { versions: ["v1.11"] });

      if (url.pathname === "/_matrix/client/v3/register") {
        if (!body.auth) {
          return reply(401, { session: "sess", flows: [{ stages: ["m.login.registration_token"] }], params: {} });
        }
        if (body.auth.type !== "m.login.registration_token" || body.auth.token !== token) {
          return reply(403, { errcode: "M_FORBIDDEN", error: "Invalid registration token" });
        }
        if (!body.initial_device_display_name) return reply(400, { errcode: "M_MISSING_PARAM", error: "initial_device_display_name" });
        if (registered.has(body.username)) return reply(400, { errcode: "M_USER_IN_USE", error: "User ID already taken." });
        registered.set(body.username, body.password);
        return reply(200, { user_id: `@${body.username}:${DOMAIN}` });
      }

      if (url.pathname === "/_matrix/client/v3/login") {
        const name = usernameOf(body.identifier.user);
        if (registered.get(name) !== body.password) return reply(403, { errcode: "M_FORBIDDEN", error: "Invalid password" });
        const access = `tok-${name}-${++tokenSeq}`;
        tokens.set(access, body.identifier.user);
        return reply(200, { user_id: body.identifier.user, access_token: access, device_id: "DEV" });
      }

      if (url.pathname === "/_matrix/client/v3/account/whoami") {
        whoamis++;
        if (!userId) return reply(401, { errcode: "M_UNKNOWN_TOKEN" });
        return reply(200, { user_id: userId });
      }

      if (url.pathname.startsWith("/_matrix/client/v3/profile/") && url.pathname.endsWith("/displayname")) {
        if (!userId) return reply(401, { errcode: "M_UNKNOWN_TOKEN" });
        const target = decodeURIComponent(url.pathname.slice("/_matrix/client/v3/profile/".length, -"/displayname".length));
        displayNames.set(target, body.displayname);
        return reply(200, {});
      }

      if (url.pathname === "/_matrix/client/v3/joined_rooms") {
        if (!userId) return reply(401, { errcode: "M_UNKNOWN_TOKEN" });
        const joined = [...rooms.entries()].filter(([, members]) => members.has(userId)).map(([id]) => id);
        return reply(200, { joined_rooms: joined });
      }

      const stateName = url.pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/m\.room\.name\/?$/);
      if (stateName) {
        if (!userId) return reply(401, { errcode: "M_UNKNOWN_TOKEN" });
        const roomId = decodeURIComponent(stateName[1]);
        if (req.method === "GET") {
          const name = roomNamesById.get(roomId);
          return name === undefined ? reply(404, { errcode: "M_NOT_FOUND" }) : reply(200, { name });
        }
        roomNamesById.set(roomId, body.name);
        return reply(200, {});
      }

      const sendMessage = url.pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m\.room\.message\/[^/]+$/);
      if (sendMessage && req.method === "PUT") {
        if (!userId) return reply(401, { errcode: "M_UNKNOWN_TOKEN" });
        sentMessages.push({ roomId: decodeURIComponent(sendMessage[1]), body: body.body });
        return reply(200, { event_id: `$ev${sentMessages.length}` });
      }

      if (url.pathname === "/_matrix/client/v3/createRoom") {
        if (!userId) return reply(401, { errcode: "M_UNKNOWN_TOKEN" });
        creates++;
        roomNames.push(body.name);
        const roomId = `!room${roomSeq === 0 ? "" : roomSeq}:${DOMAIN}`;
        roomSeq++;
        roomNamesById.set(roomId, body.name);
        const members = new Set<string>([userId, ...((body.invite as string[] | undefined) ?? [])]);
        rooms.set(roomId, members);
        return reply(200, { room_id: roomId });
      }

      reply(404, { errcode: "M_UNRECOGNIZED" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock homeserver failed to listen");
  return {
    server,
    url: `http://127.0.0.1:${addr.port}`,
    registered,
    createRoomCount: () => creates,
    whoamiCount: () => whoamis,
    roomNames: () => roomNames,
    roomNameOf: (roomId: string) => roomNamesById.get(roomId),
    messages: () => sentMessages,
    displayNames: () => displayNames,
  };
}

function runBootstrap(url: string, accountFile: string, registrationToken = "it-token", backupFile?: string, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOMESERVER_URL: url,
      REGISTRATION_TOKEN: registrationToken,
      BOT_ACCOUNT_FILE: accountFile,
      ...extraEnv,
    };
    delete env.BOT_ACCOUNT_BACKUP_FILE;
    if (backupFile) env.BOT_ACCOUNT_BACKUP_FILE = backupFile;
    execFile(
      process.execPath,
      ["deploy/bootstrap/bootstrap.mjs"],
      { env },
      (err, stdout, stderr) => resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr }),
    );
  });
}

test("bootstrap registers bot+human, logs in, creates the room, writes the account file", async () => {
  const mock = await startMockHomeserver();
  const dataDir = await mkdtemp(path.join(tmpdir(), "alveole-bootstrap-it-"));
  const accountFile = path.join(dataDir, "bot-account.json");
  try {
    const first = await runBootstrap(mock.url, accountFile);
    assert.equal(first.code, 0, `bootstrap failed: ${first.stderr}`);

    const account = JSON.parse(await readFile(accountFile, "utf8"));
    assert.equal(account.homeserverUrl, mock.url);
    assert.equal(account.botUserId, `@coding-agent:${DOMAIN}`);
    assert.equal(account.humanUserId, `@user:${DOMAIN}`);
    assert.match(account.botAccessToken, /^tok-coding-agent-/);
    assert.equal(account.roomId, `!room:${DOMAIN}`);
    assert.match(account.humanPassword, /^[0-9a-f]{48}$/);
    assert.match(account.botPassword, /^[0-9a-f]{48}$/);
    assert.deepEqual([...mock.registered.keys()].sort(), ["coding-agent", "user"]);
    assert.equal(mock.roomNames()[0], "unicorn-project");
    assert.equal(mock.roomNameOf(`!room:${DOMAIN}`), "unicorn-project");
    assert.equal(mock.displayNames().get(`@coding-agent:${DOMAIN}`), "Coding Agent");
    // The demo room gets exactly one welcome message, naming the bot to invite.
    assert.equal(mock.messages().length, 1);
    assert.equal(mock.messages()[0].roomId, `!room:${DOMAIN}`);
    assert.match(mock.messages()[0].body, /@coding-agent:localhost:8008/);
    assert.equal((await stat(accountFile)).mode & 0o777, 0o600);
    assert.match(first.stdout, /Alvéole is ready/);
    assert.match(first.stdout, /GitHub PAT/);

    // Idempotent second run: reconciles against the homeserver, reuses the
    // accounts and the room, and does NOT register anyone or create a room.
    const second = await runBootstrap(mock.url, accountFile);
    assert.equal(second.code, 0, `idempotent run failed: ${second.stderr}`);
    assert.match(second.stdout, /reconciled/);
    assert.match(second.stdout, /reused room/);
    assert.equal(mock.registered.size, 2);
    assert.equal(mock.createRoomCount(), 1);
    assert.equal(mock.messages().length, 1); // welcome is not repeated on restart

    const again = JSON.parse(await readFile(accountFile, "utf8"));
    assert.equal(again.humanPassword, account.humanPassword); // password never rotated
  } finally {
    mock.server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("bootstrap self-heals a stale account file after the homeserver was reset", async () => {
  // Fresh homeserver (no accounts) + a surviving /data file with dead creds.
  const mock = await startMockHomeserver();
  const dataDir = await mkdtemp(path.join(tmpdir(), "alveole-bootstrap-it-"));
  const accountFile = path.join(dataDir, "bot-account.json");
  const stale = {
    homeserverUrl: mock.url,
    botUserId: `@alveole:${DOMAIN}`,
    botAccessToken: "dead-token",
    botPassword: "deadbotpassword000000000000000000000000000000000000000000",
    humanUserId: `@user:${DOMAIN}`,
    humanPassword: "deadhumanpassword0000000000000000000000000000000000000000000",
    roomId: `!old:${DOMAIN}`,
  };
  await writeFile(accountFile, JSON.stringify(stale), { mode: 0o600 });
  try {
    const run = await runBootstrap(mock.url, accountFile);
    assert.equal(run.code, 0, `self-heal failed: ${run.stderr}`);

    const account = JSON.parse(await readFile(accountFile, "utf8"));
    // Recreated on the reset homeserver...
    assert.deepEqual([...mock.registered.keys()].sort(), ["coding-agent", "user"]);
    assert.equal(account.botUserId, `@coding-agent:${DOMAIN}`);
    assert.equal(account.botAccessToken, "tok-coding-agent-1");
    assert.notEqual(account.roomId, stale.roomId);
    // ...but passwords are preserved, so the human's sign-in still works.
    assert.equal(account.botPassword, stale.botPassword);
    assert.equal(account.humanPassword, stale.humanPassword);
    assert.match(run.stdout, /recreated/);
  } finally {
    mock.server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("bootstrap recovers when the file is lost but the accounts already exist", async () => {
  // Homeserver persisted, /data/bot-account.json vanished. The bot's password is
  // unrecoverable, so it takes a fresh username; the human is still signed in, so
  // their existing account is kept and invited (not replaced).
  const mock = await startMockHomeserver({ accounts: { "coding-agent": "secret-bot", user: "secret-human" } });
  const dataDir = await mkdtemp(path.join(tmpdir(), "alveole-bootstrap-it-"));
  const accountFile = path.join(dataDir, "missing.json");
  try {
    const run = await runBootstrap(mock.url, accountFile);
    assert.equal(run.code, 0, `recovery failed: ${run.stderr}`);

    const account = JSON.parse(await readFile(accountFile, "utf8"));
    assert.match(account.botUserId, /^@coding-agent-[0-9a-f]{4}:localhost:8008$/);
    assert.equal(account.humanUserId, `@user:${DOMAIN}`); // the signed-in human, not a new one
    assert.equal(account.humanPassword, undefined); // unknown; not needed to invite
    assert.equal(account.roomId, `!room:${DOMAIN}`);
    assert.match(account.botAccessToken, /^tok-coding-agent-/);
    // No new human account was created: only a suffixed bot joined the originals.
    const keys = [...mock.registered.keys()].sort();
    assert.equal(keys.length, 3);
    assert.ok(keys.includes("coding-agent") && keys.includes("user"));
    assert.ok(keys.some((k) => /^coding-agent-[0-9a-f]{4}$/.test(k)));
  } finally {
    mock.server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("bootstrap recovers when the account file is stale but the accounts still exist", async () => {
  // File present but its password no longer matches the live account (e.g. the
  // file was restored from a different homeserver): login fails, register hits
  // M_USER_IN_USE, and the suffixed fallback still yields a working bot while
  // the existing human is kept.
  const mock = await startMockHomeserver({ accounts: { "coding-agent": "current", user: "current" } });
  const dataDir = await mkdtemp(path.join(tmpdir(), "alveole-bootstrap-it-"));
  const accountFile = path.join(dataDir, "bot-account.json");
  await writeFile(accountFile, JSON.stringify({
    homeserverUrl: mock.url,
    botUserId: `@coding-agent:${DOMAIN}`,
    botAccessToken: "dead-token",
    botPassword: "stale-bot-password",
    humanUserId: `@user:${DOMAIN}`,
    humanPassword: "stale-human-password",
    roomId: `!old:${DOMAIN}`,
  }), { mode: 0o600 });
  try {
    const run = await runBootstrap(mock.url, accountFile);
    assert.equal(run.code, 0, `recovery failed: ${run.stderr}`);
    const account = JSON.parse(await readFile(accountFile, "utf8"));
    assert.match(account.botUserId, /^@coding-agent-[0-9a-f]{4}:localhost:8008$/);
    assert.equal(account.humanUserId, `@user:${DOMAIN}`);
    assert.notEqual(account.roomId, `!old:${DOMAIN}`);
  } finally {
    mock.server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("bootstrap restores the same bot and room from the homeserver-data backup when /data is lost", async () => {
  const mock = await startMockHomeserver();
  const dataDir = await mkdtemp(path.join(tmpdir(), "alveole-bootstrap-it-"));
  const backupDir = await mkdtemp(path.join(tmpdir(), "alveole-bootstrap-backup-"));
  const accountFile = path.join(dataDir, "bot-account.json");
  const backupFile = path.join(backupDir, "bot-account.json");
  try {
    const first = await runBootstrap(mock.url, accountFile, "it-token", backupFile);
    assert.equal(first.code, 0, `first run failed: ${first.stderr}`);
    const account = JSON.parse(await readFile(backupFile, "utf8"));
    assert.equal(account.botUserId, `@coding-agent:${DOMAIN}`);

    // Lose /data: the primary file is gone, only the homeserver-side copy remains.
    await rm(accountFile, { force: true });
    const second = await runBootstrap(mock.url, accountFile, "it-token", backupFile);
    assert.equal(second.code, 0, `restore failed: ${second.stderr}`);
    const restored = JSON.parse(await readFile(accountFile, "utf8"));
    assert.equal(restored.botUserId, `@coding-agent:${DOMAIN}`); // SAME bot
    assert.equal(restored.roomId, account.roomId); // SAME room
    assert.equal(restored.botAccessToken, account.botAccessToken);
    assert.deepEqual([...mock.registered.keys()].sort(), ["coding-agent", "user"]); // no new accounts
    assert.equal(mock.createRoomCount(), 1); // no new room
    assert.match(second.stdout, /reconciled/);
  } finally {
    mock.server.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
});

test("bootstrap syncs the reused demo room name to ALVEOLE_ROOM_NAME and welcomes once", async () => {
  const mock = await startMockHomeserver();
  const dataDir = await mkdtemp(path.join(tmpdir(), "alveole-bootstrap-it-"));
  const accountFile = path.join(dataDir, "bot-account.json");
  try {
    const first = await runBootstrap(mock.url, accountFile, "it-token", undefined, { ALVEOLE_ROOM_NAME: "Old Name" });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(mock.roomNameOf(`!room:${DOMAIN}`), "Old Name");
    assert.equal(mock.messages().length, 1);

    // Config renamed: the reused room is renamed in place and re-welcomed once.
    const second = await runBootstrap(mock.url, accountFile, "it-token", undefined, { ALVEOLE_ROOM_NAME: "Unicorn Project" });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /renamed room/);
    assert.equal(mock.roomNameOf(`!room:${DOMAIN}`), "Unicorn Project");
    assert.equal(mock.messages().length, 2);
    assert.equal(mock.createRoomCount(), 1); // renamed, not recreated

    // Steady state: nothing changes, no extra message.
    const third = await runBootstrap(mock.url, accountFile, "it-token", undefined, { ALVEOLE_ROOM_NAME: "Unicorn Project" });
    assert.equal(third.code, 0, third.stderr);
    assert.equal(mock.messages().length, 2);
    assert.equal(mock.createRoomCount(), 1);
  } finally {
    mock.server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("bootstrap refuses to register without a REGISTRATION_TOKEN when the homeserver requires one", async () => {
  const mock = await startMockHomeserver();
  const dataDir = await mkdtemp(path.join(tmpdir(), "alveole-bootstrap-it-"));
  try {
    const run = await runBootstrap(mock.url, path.join(dataDir, "no.json"), "");
    assert.equal(run.code, 1);
    assert.match(run.stderr, /REGISTRATION_TOKEN is empty/);
  } finally {
    mock.server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
