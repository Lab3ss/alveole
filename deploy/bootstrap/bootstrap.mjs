#!/usr/bin/env node
/**
 * One-shot bootstrap for the matrix-included docker-compose deployment
 * (COMPOSE_PROFILES=matrix-included). Runs on the broker image against the
 * included continuuwuity homeserver and prepares everything the broker needs.
 *
 * It RECONCILES the homeserver with /data/bot-account.json instead of trusting
 * the file's existence. Every run:
 *
 *   1. waits for the homeserver (GET /_matrix/client/versions, 2s retry, 120s);
 *   2. loads the previous account file (a cache: bot/human user ids, passwords,
 *      room id), if any;
 *   3. ensures the bot account exists — reuses the stored access token when it
 *      still answers whoami, else logs in with the stored bot password, else
 *      registers (creating a password only when registering);
 *   4. ensures the human account exists the same way (login with the stored
 *      password, else register) so the human's password survives a homeserver
 *      reset instead of being rotated every run;
 *   5. reuses the stored room when the bot is still joined to it, else creates
 *      the shared room (private_chat, human invited, NOT encrypted — the broker
 *      has no E2EE);
 *   6. atomically rewrites /data/bot-account.json (0600) for the broker to pick
 *      up (src/broker.ts) and prints the human-facing credentials block that
 *      `docker compose logs bootstrap` shows.
 *
 * This makes restarts idempotent AND self-healing: if the homeserver data was
 * reset while /data survived, the stale file is detected (whoami/login fail),
 * the accounts and room are recreated, and the file is rewritten — no wipe, no
 * duplicate room. The recovery is keyed on the homeserver's reality, never on
 * fs.existsSync. Only node built-ins (node 22, global fetch).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const ACCOUNT_FILE = process.env.BOT_ACCOUNT_FILE ?? "/data/bot-account.json";
const HOMESERVER_URL = (process.env.HOMESERVER_URL ?? "http://homeserver:8008").replace(/\/+$/, "");
const HOMESERVER_PUBLIC_URL = process.env.HOMESERVER_PUBLIC_URL ?? "http://localhost:8008";
const REGISTRATION_TOKEN = process.env.REGISTRATION_TOKEN ?? "";
const BOT_USER = process.env.ALVEOLE_BOT_USER ?? "alveole";
const HUMAN_USER = process.env.ALVEOLE_USER_NAME ?? "user";
const ROOM_NAME = process.env.ALVEOLE_ROOM_NAME ?? "Alvéole";

const fail = (msg) => {
  console.error(`[bootstrap] ${msg}`);
  process.exit(1);
};

const printSummary = (acct) => {
  const line = "─".repeat(64);
  console.log(`\n${line}\n  Alvéole is ready.\n\n  Element Web:  http://localhost:8080 (or http://<this-host-LAN-ip>:8080 from your phone)\n  Homeserver:   ${HOMESERVER_PUBLIC_URL}\n  Sign in as:   ${acct.humanUserId}\n  Password:     ${acct.humanPassword}\n  Room:         ${ROOM_NAME} — the bot (@${BOT_USER}) is waiting there\n\n  Say hi in the room, send it a repo, and it will ask for a\n  GitHub PAT scoped to that repo — paste it when it asks.\n${line}\n`);
};

const loadPrev = () => {
  try {
    return JSON.parse(readFileSync(ACCOUNT_FILE, "utf8"));
  } catch {
    return undefined; // absent, partial, or corrupt — treat as a fresh run
  }
};

const api = async (method, path, body, token) => {
  const res = await fetch(HOMESERVER_URL + "/_matrix/client" + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
};

// The homeserver may still be starting its first run (DB init) — poll versions.
let up = false;
for (let deadline = Date.now() + 120_000; Date.now() < deadline; ) {
  try {
    const res = await api("GET", "/versions");
    if (res.ok) {
      up = true;
      break;
    }
  } catch {
    // not listening yet
  }
  await new Promise((r) => setTimeout(r, 2_000));
}
if (!up) fail(`homeserver at ${HOMESERVER_URL} did not answer /_matrix/client/versions within 120s (check the homeserver container's logs)`);

// Matrix UIAA: the first POST gets a 401 carrying the flow session; resending
// with an auth matching one of the server's advertised stages completes it.
// Registration token is the preferred (and, on stock continuuwuity images,
// the only) path; open registration via m.login.dummy is attempted when the
// server offers it. Conduwuity requires initial_device_display_name on register.
const register = async (username, password) => {
  const body = { username, password, initial_device_display_name: "alveole bootstrap", inhibit_login: true };
  let res = await api("POST", "/v3/register", body);
  if (res.status === 401 && res.data?.session) {
    const stages = (res.data.flows ?? []).flatMap((f) => f.stages ?? []);
    const auth = REGISTRATION_TOKEN
      ? { type: "m.login.registration_token", token: REGISTRATION_TOKEN, session: res.data.session }
      : stages.includes("m.login.dummy")
        ? { type: "m.login.dummy", session: res.data.session }
        : null;
    if (!auth) {
      throw new Error(
        `homeserver registration requires a token (${stages.join(", ") || "none advertised"}) but REGISTRATION_TOKEN is empty — set it in .env (e.g. openssl rand -hex 12)`,
      );
    }
    res = await api("POST", "/v3/register", { ...body, auth });
  }
  if (!res.ok) throw new Error(`registering @${username} failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data.user_id;
};

/** Login and return the access token, or undefined when the credentials don't work. */
const tryLogin = async (userId, password, device) => {
  const res = await api("POST", "/v3/login", {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: userId },
    password,
    initial_device_display_name: device,
  });
  return res.ok ? res.data.access_token : undefined;
};

/** Does this access token still belong to a live session on the homeserver? */
const tokenIsLive = async (token) => {
  try {
    const res = await api("GET", "/v3/account/whoami", undefined, token);
    return res.ok;
  } catch {
    return false;
  }
};

const joinedRoomIds = async (token) => {
  const res = await api("GET", "/v3/joined_rooms", undefined, token);
  return res.ok && Array.isArray(res.data.joined_rooms) ? res.data.joined_rooms : [];
};

const newPassword = () => randomBytes(24).toString("hex");

const prev = loadPrev();

let botUserId = prev?.botUserId;
let botPassword = prev?.botPassword;
let botAccessToken = prev?.botAccessToken;
let humanUserId = prev?.humanUserId;
let humanPassword = prev?.humanPassword;
let roomId = prev?.roomId;
let botReused = false;

try {
  // --- bot account ---------------------------------------------------------
  // Prefer the stored token (cheap, no new device); fall back to the stored
  // password; only register when the account is genuinely gone. This is what
  // detects the "file survived, homeserver was reset" case: whoami 401s, login
  // 403s, and we recreate the account instead of handing the broker a dead token.
  if (botUserId && botAccessToken && (await tokenIsLive(botAccessToken))) {
    botReused = true;
  } else {
    let token = botUserId && botPassword ? await tryLogin(botUserId, botPassword, "alveole-broker") : undefined;
    if (!token) {
      botPassword = botPassword ?? newPassword();
      botUserId = await register(BOT_USER, botPassword);
      token = await tryLogin(botUserId, botPassword, "alveole-broker");
      if (!token) throw new Error(`could not log the bot in after registering @${BOT_USER}`);
    }
    botAccessToken = token;
  }

  // --- human account -------------------------------------------------------
  // Reuse the stored password whenever the account still exists so the human's
  // sign-in survives restarts and homeserver resets alike. Only generate a new
  // password when we actually have to register a fresh account.
  if (!(humanUserId && humanPassword && botReused)) {
    humanPassword = humanPassword ?? newPassword();
    const token = humanUserId ? await tryLogin(humanUserId, humanPassword, "alveole-human") : undefined;
    if (!token) humanUserId = await register(HUMAN_USER, humanPassword);
  }

  // --- shared room ---------------------------------------------------------
  // Reuse the room only when the bot is still joined to it; otherwise create a
  // new one. Keeps restarts from spawning a room per `up`.
  let roomReused = false;
  if (roomId && (await joinedRoomIds(botAccessToken)).includes(roomId)) {
    roomReused = true;
  } else {
    const roomRes = await api("POST", "/v3/createRoom", { name: ROOM_NAME, invite: [humanUserId], preset: "private_chat" }, botAccessToken);
    if (!roomRes.ok) throw new Error(`creating the room failed: ${roomRes.status} ${JSON.stringify(roomRes.data)}`);
    roomId = roomRes.data.room_id;
  }

  const account = {
    homeserverUrl: HOMESERVER_URL,
    botUserId,
    botAccessToken,
    botPassword,
    humanUserId,
    humanPassword,
    roomId,
  };
  const tmp = `${ACCOUNT_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(account, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, ACCOUNT_FILE); // atomic — the broker polls this file

  console.log(
    `[bootstrap] ${botReused ? "reconciled" : "recreated"} bot account, ${roomReused ? "reused" : "created"} room ${roomId}; ${ACCOUNT_FILE} written for the broker`,
  );
  printSummary(account);
} catch (err) {
  fail(`${err.message}\n[bootstrap] hint: if the accounts already exist on the homeserver but ${ACCOUNT_FILE} was lost, restore it (or wipe the homeserver-data volume) and re-run; a mismatched password cannot be recovered through the client API`);
}
