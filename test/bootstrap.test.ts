/**
 * End-to-end test of deploy/bootstrap/bootstrap.mjs against a mock Matrix
 * homeserver: UIAA token registration (401 dance), bot login, room creation,
 * atomic 0600 account file, and the idempotent second run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

test("bootstrap registers bot+human, logs in, creates the room, writes the account file", async () => {
  const TOKEN = "it-token";
  const sessions = new Set();
  const registered = new Map();
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
      if (url.pathname === "/_matrix/client/versions") return reply(200, { versions: ["v1.11"] });
      if (url.pathname === "/_matrix/client/v3/register") {
        if (!body.auth) {
          const session = "sess-" + sessions.size;
          sessions.add(session);
          return reply(401, { session, flows: [{ stages: ["m.login.registration_token"] }], params: {} });
        }
        if (body.auth.type !== "m.login.registration_token" || body.auth.token !== TOKEN) {
          return reply(403, { errcode: "M_FORBIDDEN", error: "Invalid registration token" });
        }
        if (!body.initial_device_display_name) return reply(400, { errcode: "M_MISSING_PARAM", error: "initial_device_display_name" });
        const userId = `@${body.username}:localhost`;
        registered.set(body.username, body.password);
        return reply(200, { user_id: userId });
      }
      if (url.pathname === "/_matrix/client/v3/login") {
        return reply(200, { user_id: body.identifier.user, access_token: "bot-access-token", device_id: "DEV" });
      }
      if (url.pathname === "/_matrix/client/v3/createRoom") {
        if (req.headers.authorization !== "Bearer bot-access-token") return reply(401, { errcode: "M_UNKNOWN_TOKEN" });
        return reply(200, { room_id: "!room:localhost" });
      }
      reply(404, { errcode: "M_UNRECOGNIZED" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock homeserver failed to listen");
  const port = addr.port;

  const dataDir = await mkdtemp(path.join(tmpdir(), "alveole-bootstrap-it-"));
  const accountFile = path.join(dataDir, "bot-account.json");
  const run = () =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        ["deploy/bootstrap/bootstrap.mjs"],
        {
          env: {
            ...process.env,
            HOMESERVER_URL: `http://127.0.0.1:${port}`,
            REGISTRATION_TOKEN: TOKEN,
            BOT_ACCOUNT_FILE: accountFile,
          },
        },
        (err, stdout, stderr) => resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr }),
      );
    });

  try {
    const first = await run();
    assert.equal(first.code, 0, `bootstrap failed: ${first.stderr}`);

    const account = JSON.parse(await readFile(accountFile, "utf8"));
    assert.equal(account.homeserverUrl, `http://127.0.0.1:${port}`);
    assert.equal(account.botUserId, "@alveole:localhost");
    assert.equal(account.humanUserId, "@user:localhost");
    assert.equal(account.botAccessToken, "bot-access-token");
    assert.equal(account.roomId, "!room:localhost");
    assert.match(account.humanPassword, /^[0-9a-f]{48}$/);
    assert.deepEqual([...registered.keys()].sort(), ["alveole", "user"]);
    assert.equal((await stat(accountFile)).mode & 0o777, 0o600);
    assert.match(first.stdout, /Alvéole is ready/);
    assert.match(first.stdout, /GitHub PAT/);

    // Idempotent second run: exits 0 without re-registering.
    const second = await run();
    assert.equal(second.code, 0, `idempotent run failed: ${second.stderr}`);
    assert.match(second.stdout, /nothing to do/);
    assert.equal(registered.size, 2); // no extra accounts created
  } finally {
    server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("bootstrap refuses to run without a REGISTRATION_TOKEN when the homeserver requires one", async () => {
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (new URL(req.url ?? "/", "http://x").pathname === "/_matrix/client/versions") return reply(200, { versions: ["v1.11"] });
    // token-gated registration, like stock continuuwuity images
    reply(401, { session: "s1", flows: [{ stages: ["m.login.registration_token"] }], params: {} });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock homeserver failed to listen");
  const port = addr.port;
  const dataDir = await mkdtemp(path.join(tmpdir(), "alveole-bootstrap-it-"));
  try {
    const code = await new Promise<number>((resolve) => {
      execFile(
        process.execPath,
        ["deploy/bootstrap/bootstrap.mjs"],
        { env: { ...process.env, HOMESERVER_URL: `http://127.0.0.1:${port}`, REGISTRATION_TOKEN: "", BOT_ACCOUNT_FILE: path.join(dataDir, "no.json") } },
        (err) => resolve(err && typeof err.code === "number" ? err.code : err ? 1 : 0),
      );
    });
    assert.equal(code, 1);
  } finally {
    server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
