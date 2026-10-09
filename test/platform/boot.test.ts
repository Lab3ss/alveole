import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { cryptoStorePath, resolveMatrixCredentials } from "../../src/platform/boot.ts";

async function withAccountFile(content: string, fn: (file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "alveole-boot-test-"));
  const file = path.join(dir, "bot-account.json");
  await writeFile(file, content);
  try {
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("explicit credentials short-circuit without reading a file", async () => {
  const creds = await resolveMatrixCredentials({
    homeserver: "http://hs",
    token: "tok",
    accountFile: "/nonexistent/bot-account.json",
    waitMs: 0,
  });
  assert.deepEqual(creds, { homeserver: "http://hs", token: "tok" });
});

test("reads the bootstrap account file when no credentials are set", async () => {
  await withAccountFile(JSON.stringify({ homeserverUrl: "http://hs", botAccessToken: "tok" }), async (file) => {
    const creds = await resolveMatrixCredentials({ accountFile: file, waitMs: 0, sleep: async () => {} });
    assert.deepEqual(creds, { homeserver: "http://hs", token: "tok" });
  });
});

test("a coherent file pair wins over a half-set env var (take both or neither)", async () => {
  await withAccountFile(JSON.stringify({ homeserverUrl: "http://file", botAccessToken: "tok-file" }), async (file) => {
    const creds = await resolveMatrixCredentials({
      homeserver: "http://env",
      token: "",
      accountFile: file,
      waitMs: 0,
      sleep: async () => {},
    });
    assert.deepEqual(creds, { homeserver: "http://file", token: "tok-file" });
  });
});

test("throws when neither env nor the account file yields a pair", async () => {
  await assert.rejects(
    resolveMatrixCredentials({ accountFile: "/nonexistent/bot-account.json", waitMs: 0, sleep: async () => {} }),
    /MATRIX_HOMESERVER and MATRIX_TOKEN required/,
  );
});

test("does not sleep when the account file is already present", async () => {
  let attempts = 0;
  await withAccountFile(JSON.stringify({ homeserverUrl: "http://hs", botAccessToken: "tok" }), async (file) => {
    const creds = await resolveMatrixCredentials({
      accountFile: file,
      waitMs: 10_000,
      sleep: async () => {
        attempts++;
      },
    });
    assert.deepEqual(creds, { homeserver: "http://hs", token: "tok" });
    assert.equal(attempts, 0); // found on the first pass, no sleeping
  });
});

test("cryptoStorePath defaults next to the registry DB and honors overrides", () => {
  assert.equal(cryptoStorePath({ REGISTRY_DB_PATH: "/data/registry.db" }), "/data/crypto-store");
  assert.equal(cryptoStorePath({ REGISTRY_DB_PATH: "/data/registry.db", MATRIX_CRYPTO_STORE: "/keys" }), "/keys");
  assert.equal(cryptoStorePath({ REGISTRY_DB_PATH: "/data/registry.db", MATRIX_E2EE: "false" }), undefined);
});
