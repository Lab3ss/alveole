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
 *      room id), if any — falling back to the copy kept in the homeserver's own
 *      data volume so losing /data alone still restores the SAME bot and room;
 *   3. ensures the bot account exists — reuses the stored access token when it
 *      still answers whoami, else logs in with the stored bot password, else
 *      registers (creating a password only when registering), and sets its
 *      profile display name (ALVEOLE_BOT_DISPLAY_NAME, default "Coding Agent";
 *      the localpart ALVEOLE_BOT_USER stays a valid Matrix username). If the
 *      username is taken but no stored credential works (the file was lost
 *      while the homeserver kept the accounts), it falls back to a unique
 *      suffixed username rather than failing — a bot that exists beats a
 *      bricked install;
 *   4. ensures the human account exists: login with the stored password, else
 *      register. If the human already exists but we hold no working password,
 *      keep the existing user id and invite it (a fresh human would invite the
 *      wrong person and leave the logged-in one out of the room);
 *   5. reuses the stored room when the bot is still joined to it, else creates
 *      the shared room (private_chat, human invited, NOT encrypted — the broker
 *      has no E2EE);
 *   6. atomically rewrites /data/bot-account.json (0600) for the broker to pick
 *      up (src/broker.ts), mirrors it to the homeserver-data copy, and prints
 *      the human-facing credentials block that `docker compose logs bootstrap`
 *      shows.
 *
 * This makes restarts idempotent AND self-healing in both directions: a
 * surviving file plus a reset homeserver re-registers the accounts; a lost file
 * plus a surviving homeserver restores the same bot from the homeserver-data
 * copy (or, absent that, creates fresh accounts). The recovery is keyed on the
 * homeserver's reality, never on fs.existsSync. Only node built-ins (node 22,
 * global fetch).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const ACCOUNT_FILE = process.env.BOT_ACCOUNT_FILE ?? "/data/bot-account.json";
// Optional second copy of the account file, kept inside the homeserver's own
// data volume (see deploy/docker-compose.yml). The two volumes are independent,
// so losing /data alone would lose the bot's credentials while the homeserver
// keeps the accounts and the room — restoring from here brings the SAME bot
// (and room) back instead of creating new ones.
const BACKUP_FILE = process.env.BOT_ACCOUNT_BACKUP_FILE;
const HOMESERVER_URL = (process.env.HOMESERVER_URL ?? "http://homeserver:8008").replace(/\/+$/, "");
const HOMESERVER_PUBLIC_URL = process.env.HOMESERVER_PUBLIC_URL ?? "http://localhost:8008";
const REGISTRATION_TOKEN = process.env.REGISTRATION_TOKEN ?? "";
const BOT_USER = process.env.ALVEOLE_BOT_USER ?? "coding-agent";
const BOT_DISPLAY_NAME = process.env.ALVEOLE_BOT_DISPLAY_NAME ?? "Coding Agent";
const HUMAN_USER = process.env.ALVEOLE_USER_NAME ?? "user";
const ROOM_NAME = process.env.ALVEOLE_ROOM_NAME ?? "unicorn-project";

const fail = (msg) => {
  console.error(`[bootstrap] ${msg}`);
  process.exit(1);
};

const printSummary = (acct) => {
  const line = "─".repeat(64);
  const password = acct.humanPassword ?? "(unchanged — use the password you already have)";
  console.log(`\n${line}\n  Alvéole is ready.\n\n  Element Web:  http://localhost:8080 (or http://<this-host-LAN-ip>:8080 from your phone)\n  Homeserver:   ${HOMESERVER_PUBLIC_URL}\n  Sign in as:   ${acct.humanUserId}\n  Password:     ${password}\n  Room:         ${ROOM_NAME} — the bot ${BOT_DISPLAY_NAME} (${acct.botUserId}) is waiting there\n  Invite the bot to other rooms as: ${acct.botUserId}\n\n  Say hi in the room, send it a repo, and it will ask for a\n  GitHub PAT scoped to that repo — paste it when it asks.\n${line}\n`);
};

const loadPrev = () => {
  // Prefer the live file the broker reads; fall back to the copy kept with the
  // homeserver when /data was recreated but the accounts survived.
  for (const file of [ACCOUNT_FILE, BACKUP_FILE]) {
    if (!file) continue;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // absent, partial, or corrupt — try the next location
    }
  }
  return undefined;
};

/** Atomically write `account` to every configured location (best-effort for the backup). */
const persist = (account) => {
  const json = JSON.stringify(account, null, 2) + "\n";
  const tmp = `${ACCOUNT_FILE}.tmp`;
  writeFileSync(tmp, json, { mode: 0o600 });
  renameSync(tmp, ACCOUNT_FILE); // atomic — the broker polls this file
  if (BACKUP_FILE) {
    try {
      mkdirSync(BACKUP_FILE.substring(0, BACKUP_FILE.lastIndexOf("/")), { recursive: true });
      const btmp = `${BACKUP_FILE}.tmp`;
      writeFileSync(btmp, json, { mode: 0o600 });
      renameSync(btmp, BACKUP_FILE);
    } catch (err) {
      console.warn(`[bootstrap] could not write the backup at ${BACKUP_FILE}: ${err.message}`);
    }
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
  if (!res.ok) {
    const err = new Error(`registering @${username} failed: ${res.status} ${JSON.stringify(res.data)}`);
    err.errcode = res.data?.errcode; // callers recover specifically from M_USER_IN_USE
    throw err;
  }
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

/** The server name (domain) of a user id: @localpart:server → "server". */
const serverNameOf = (userId) => userId.slice(userId.indexOf(":") + 1);

/** Set the bot's profile display name (what Element shows) — best-effort. */
const setDisplayName = async (userId, displayname, token) => {
  if (!displayname) return;
  const res = await api("PUT", `/v3/profile/${encodeURIComponent(userId)}/displayname`, { displayname }, token);
  if (!res.ok) console.warn(`[bootstrap] could not set the bot display name (${res.status}); it will show as ${userId}`);
};

/** Post a plain-text message to a room as the bot — best-effort. */
const sendRoomMessage = async (roomId, body, token) => {
  const txn = `bootstrap-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const res = await api("PUT", `/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, { msgtype: "m.text", body }, token);
  if (!res.ok) console.warn(`[bootstrap] could not post the welcome message (${res.status})`);
};

const newPassword = () => randomBytes(24).toString("hex");

/**
 * Register an account, falling back to a unique suffixed username when `base`
 * is already taken. This recovers the "account file lost, homeserver kept the
 * accounts" case: the old password can't be read back through the client API,
 * so instead of failing (and leaving the broker with no bot) we create a fresh
 * account. The base name is tried first with `preferredPassword`, so a
 * homeserver reset restores the canonical identity and keeps the stored
 * password.
 */
const registerWithFallback = async (base, preferredPassword) => {
  let username = base;
  let password = preferredPassword ?? newPassword();
  for (let attempt = 0; ; attempt++) {
    try {
      return { userId: await register(username, password), password };
    } catch (err) {
      if (err?.errcode !== "M_USER_IN_USE" || attempt >= 4) throw err;
      username = `${base}-${randomBytes(2).toString("hex")}`;
      password = newPassword();
    }
  }
};

const prev = loadPrev();

let botUserId = prev?.botUserId;
let botPassword = prev?.botPassword;
let botAccessToken = prev?.botAccessToken;
let humanUserId = prev?.humanUserId;
let humanPassword = prev?.humanPassword;
let roomId = prev?.roomId;

try {
  // --- bot account ---------------------------------------------------------
  // Prefer the stored token (cheap, no new device); fall back to the stored
  // password; only register when neither works. This is what detects the "file
  // survived, homeserver was reset" case: whoami 401s, login 403s, and we
  // recreate the account. registerWithFallback then covers the inverse — the
  // file was lost but the account still exists — by taking a fresh username
  // instead of exiting with M_USER_IN_USE.
  let botReused = false;
  if (botUserId && botAccessToken && (await tokenIsLive(botAccessToken))) {
    botReused = true;
  } else {
    let token = botUserId && botPassword ? await tryLogin(botUserId, botPassword, "alveole-broker") : undefined;
    if (!token) {
      const created = await registerWithFallback(BOT_USER, botPassword);
      botUserId = created.userId;
      botPassword = created.password;
      token = await tryLogin(botUserId, botPassword, "alveole-broker");
      if (!token) throw new Error(`could not log the bot in after registering @${BOT_USER}`);
    }
    botAccessToken = token;
  }
  await setDisplayName(botUserId, BOT_DISPLAY_NAME, botAccessToken);

  // --- human account -------------------------------------------------------
  // The human only needs to be reachable so the room can invite them, and we
  // never need their password for that. Reuse the stored creds when they still
  // work; if the account already exists but we hold no working password (the
  // file was lost), KEEP the canonical user id and invite that — registering a
  // fresh human would invite a different person and leave the real one out of
  // the room. Skipping the login when the bot was reused avoids spawning a
  // device on every restart.
  if (!(humanUserId && humanPassword && botReused)) {
    const humanToken = humanUserId && humanPassword ? await tryLogin(humanUserId, humanPassword, "alveole-human") : undefined;
    if (!humanToken) {
      const password = humanPassword ?? newPassword();
      try {
        humanUserId = await register(HUMAN_USER, password);
        humanPassword = password;
      } catch (err) {
        if (err?.errcode !== "M_USER_IN_USE" || !botUserId) throw err;
        humanUserId = humanUserId ?? `@${HUMAN_USER}:${serverNameOf(botUserId)}`;
        humanPassword = undefined; // unknown, and not needed to invite them
        console.warn(`[bootstrap] human account ${humanUserId} already exists — keeping it and inviting it (password unchanged, not reprinted)`);
      }
    }
  }

  // --- shared room ---------------------------------------------------------
  // Reuse the room only when the bot is still joined to it; otherwise create a
  // new one. Keeps restarts from spawning a room per `up`. The name is kept in
  // sync with ALVEOLE_ROOM_NAME so an old install picks up a renamed default,
  // and the demo room gets a one-time welcome message when it is created or
  // (re)named.
  let roomReused = false;
  let roomInitialized = false;
  if (roomId && (await joinedRoomIds(botAccessToken)).includes(roomId)) {
    roomReused = true;
    const current = await api("GET", `/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`, undefined, botAccessToken);
    const currentName = current.ok ? current.data?.name : undefined;
    if (currentName !== ROOM_NAME) {
      const renamed = await api("PUT", `/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`, { name: ROOM_NAME }, botAccessToken);
      if (renamed.ok) {
        roomInitialized = true;
        console.log(`[bootstrap] renamed room ${roomId} to "${ROOM_NAME}"`);
      }
    }
  } else {
    const roomRes = await api("POST", "/v3/createRoom", { name: ROOM_NAME, invite: [humanUserId], preset: "private_chat" }, botAccessToken);
    if (!roomRes.ok) throw new Error(`creating the room failed: ${roomRes.status} ${JSON.stringify(roomRes.data)}`);
    roomId = roomRes.data.room_id;
    roomInitialized = true;
  }

  // One-off welcome in the demo room (only when it is first created or renamed,
  // so restarts don't repeat it): how to spin up more rooms with the bot.
  if (roomInitialized) {
    await sendRoomMessage(
      roomId,
      `Hey! I just created this first room as an example — create as many others as you want. To make me jump in, just invite ${botUserId}.`,
      botAccessToken,
    );
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
  persist(account);

  console.log(
    `[bootstrap] ${botReused ? "reconciled" : "recreated"} bot account, ${roomReused ? "reused" : "created"} room ${roomId}; ${ACCOUNT_FILE} written for the broker`,
  );
  printSummary(account);
} catch (err) {
  fail(`${err.message}\n[bootstrap] hint: a registration that keeps failing usually means the registration token is wrong or registration is disabled; if the homeserver state is inconsistent, wipe the homeserver-data volume (and optionally ${ACCOUNT_FILE}) and re-run`);
}
