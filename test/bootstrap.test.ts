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

      if (url.pathname === "/_matrix/client/v3/createRoom") {
        if (!userId) return reply(401, { errcode: "M_UNKNOWN_TOKEN" });
        creates++;
        roomNames.push(body.name);
        const roomId = `!room${roomSeq === 0 ? "" : roomSeq}:${DOMAIN}`;
        roomSeq++;
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
    displayNames: () => displayNames,
  };
}

function runBootstrap(url: string, accountFile: string, registrationToken = "it-token") {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      process.execPath,
      ["deploy/bootstrap/bootstrap.mjs"],
      {
        env: {
          ...process.env,
          HOMESERVER_URL: url,
          REGISTRATION_TOKEN: registrationToken,
          BOT_ACCOUNT_FILE: accountFile,
        },
      },
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
    assert.equal(mock.displayNames().get(`@coding-agent:${DOMAIN}`), "Coding Agent");
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

test("bootstrap fails loudly when the file is lost but the accounts already exist", async () => {
  // Homeserver persisted; /data/bot-account.json vanished: the password is
  // unrecoverable through the client API, so the only honest outcome is exit 1.
  const mock = await startMockHomeserver({ accounts: { "coding-agent": "secret-bot", user: "secret-human" } });
  const dataDir = await mkdtemp(path.join(tmpdir(), "alveole-bootstrap-it-"));
  try {
    const run = await runBootstrap(mock.url, path.join(dataDir, "missing.json"));
    assert.equal(run.code, 1);
    assert.match(run.stderr, /already exist/);
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
