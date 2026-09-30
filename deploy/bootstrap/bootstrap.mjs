#!/usr/bin/env node
/**
 * One-shot bootstrap for the bundled docker-compose deployment (profile
 * "bundled"). Runs on the broker image against the bundled continuuwuity
 * homeserver and prepares everything the broker needs:
 *
 *   1. waits for the homeserver (GET /_matrix/client/versions, 2s retry, 120s);
 *   2. creates two accounts through the client /register UIAA flow with the
 *      configured REGISTRATION_TOKEN (m.login.registration_token — the only
 *      registration path continuuwuity allows on stock images): the bot
 *      (ALVEOLE_BOT_USER, default "alveole") and the human (ALVEOLE_USER_NAME,
 *      default "user"), both with generated hex passwords;
 *   3. logs the bot in (m.login.password) for its access token;
 *   4. creates the shared room as the bot (private_chat, human invited, NOT
 *      encrypted — the broker has no E2EE);
 *   5. writes /data/bot-account.json (0600) for the broker to pick up
 *      (src/broker.ts) and prints the human-facing credentials block that
 *      `docker compose logs bootstrap` shows.
 *
 * Idempotent: if /data/bot-account.json already exists it just re-prints the
 * summary and exits 0. Only node built-ins (node 22, global fetch).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

if (existsSync(ACCOUNT_FILE)) {
  console.log("[bootstrap] /data/bot-account.json already present — nothing to do");
  try {
    printSummary(JSON.parse(readFileSync(ACCOUNT_FILE, "utf8")));
  } catch {
    // keep the idempotent exit 0 even if the file can't be re-printed
  }
  process.exit(0);
}

// Fail fast: the bundled homeserver treats an empty CONTINUWUITY_REGISTRATION_TOKEN
// as "directive specified but empty" and refuses to start, so every downstream
// wait would burn its full timeout before failing with an unrelated message.
if (!REGISTRATION_TOKEN) {
  fail(`REGISTRATION_TOKEN is empty — the bundled homeserver refuses to start without it. Set it in .env (generate one: openssl rand -hex 12), then recreate the stack (docker compose up -d)`);
}

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
  await new Promise((r) => setTimeout(r, 2000));
}
if (!up) fail(`homeserver at ${HOMESERVER_URL} did not answer /_matrix/client/versions within 120s (check the homeserver container's logs)`);

// Matrix UIAA: the first POST gets a 401 carrying the flow session; resending
// with an auth matching one of the server's advertised stages completes it.
// Registration token is the preferred (and, on stock continuuwuity images,
// the only) path; open registration via m.login.dummy is attempted when the
// server offers it — acceptable per the threat model since 8008 is never
// published. Conduwuity requires initial_device_display_name on register.
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

const login = async (userId, password, device) => {
  const res = await api("POST", "/v3/login", {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: userId },
    password,
    initial_device_display_name: device,
  });
  if (!res.ok) throw new Error(`login for ${userId} failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data.access_token;
};

const botPassword = randomBytes(24).toString("hex");
const humanPassword = randomBytes(24).toString("hex");

let botUserId;
let humanUserId;
try {
  botUserId = await register(BOT_USER, botPassword);
  humanUserId = await register(HUMAN_USER, humanPassword);
} catch (err) {
  fail(`${err.message}\n[bootstrap] hint: if the accounts already exist from a previous run, wipe the homeserver-data volume and delete ${ACCOUNT_FILE} to start over`);
}

const botAccessToken = await login(botUserId, botPassword, "alveole-broker");

const roomRes = await api("POST", "/v3/createRoom", { name: ROOM_NAME, invite: [humanUserId], preset: "private_chat" }, botAccessToken);
if (!roomRes.ok) fail(`creating the room failed: ${roomRes.status} ${JSON.stringify(roomRes.data)}`);

const account = {
  homeserverUrl: HOMESERVER_URL,
  botUserId,
  botAccessToken,
  humanUserId,
  humanPassword,
  roomId: roomRes.data.room_id,
};
const tmp = `${ACCOUNT_FILE}.tmp`;
writeFileSync(tmp, JSON.stringify(account, null, 2) + "\n", { mode: 0o600 });
renameSync(tmp, ACCOUNT_FILE); // atomic — the broker polls this file

console.log(`[bootstrap] bot account + room created; ${ACCOUNT_FILE} written for the broker`);
printSummary(account);
