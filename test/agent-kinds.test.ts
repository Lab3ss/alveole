import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentKinds, loadAgentModule, resolveAgentName } from "../src/agent-kinds.ts";

test("both kinds are registered", () => {
  assert.deepEqual(agentKinds().sort(), ["assistant", "coding"]);
});

test("an unknown kind fails with the list of valid ones", async () => {
  await assert.rejects(loadAgentModule("nope"), /unknown AGENT_KIND "nope".*coding, assistant/);
  await assert.rejects(loadAgentModule("constructor"), /unknown AGENT_KIND/); // not an inherited property
});

test("coding keeps its historical (unprefixed) names; every other kind must name itself", () => {
  assert.equal(resolveAgentName("coding", {}), undefined);
  assert.equal(resolveAgentName("coding", { AGENT_NAME: " lab " }), "lab");
  assert.equal(resolveAgentName("assistant", { AGENT_NAME: "haiku" }), "haiku");
  assert.throws(() => resolveAgentName("assistant", {}), /AGENT_NAME required for AGENT_KIND=assistant/);
  assert.throws(() => resolveAgentName("assistant", { AGENT_NAME: "  " }), /AGENT_NAME required/);
});

/** Loads `kind` in a fresh process against a throwaway registry DB and returns that DB's rooms columns. */
function loadAndListColumns(kind: string): string[] {
  const db = path.join(mkdtempSync(path.join(tmpdir(), "agent-kinds-")), "registry.db");
  const script = `
    const { loadAgentModule } = await import(${JSON.stringify(path.resolve("src/agent-kinds.ts"))});
    const m = await loadAgentModule(${JSON.stringify(kind)});
    if (typeof m.agentLayerFromEnv !== "function") throw new Error("no agentLayerFromEnv");
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, REGISTRY_DB_PATH: db },
    stdio: "pipe",
  });
  const conn = new DatabaseSync(db);
  const cols = (conn.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>).map((c) => c.name);
  conn.close();
  return cols;
}

test("an assistant process never loads the coding agent (its registry would add repo/token columns)", () => {
  const assistant = loadAndListColumns("assistant");
  assert.ok(assistant.includes("pod_name"));
  for (const coding of ["repo", "token", "onboarding", "git_author_name"]) {
    assert.ok(!assistant.includes(coding), `assistant registry must not have ${coding}`);
  }
  // Positive control: the coding kind does create them, so the check above can fail.
  assert.ok(loadAndListColumns("coding").includes("repo"));
});
