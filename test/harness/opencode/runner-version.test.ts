import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { EXPECTED_OPENCODE_VERSION } from "../../../src/harness/opencode/opencode.ts";

// The broker's HTTP contract targets exactly one opencode version (see
// src/harness/opencode/opencode.ts). Every agent's runner Dockerfile is another
// place that version lives, so this test is what keeps them from silently
// drifting apart — a drift is a moved route/event that, at runtime, errors
// confusingly (or not at all).
const AGENTS = new URL("../../../src/agents/", import.meta.url);

/** Every agents/<name>/runner/Dockerfile in the repo. */
async function runnerDockerfiles(): Promise<Array<{ agent: string; content: string }>> {
  const out: Array<{ agent: string; content: string }> = [];
  for (const entry of await readdir(AGENTS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push({ agent: entry.name, content: await readFile(new URL(`${entry.name}/runner/Dockerfile`, AGENTS), "utf8") });
    } catch {
      // an agent without a runner image of its own
    }
  }
  return out;
}

test("at least one agent ships a runner image", async () => {
  assert.ok((await runnerDockerfiles()).length > 0);
});

test("every runner/Dockerfile pins the opencode version the broker expects", async () => {
  for (const { agent, content } of await runnerDockerfiles()) {
    const match = content.match(/^\s*ARG\s+OPENCODE_VERSION=(\S+)/m);
    assert.ok(match, `${agent}/runner/Dockerfile must declare ARG OPENCODE_VERSION=<version>`);
    assert.equal(
      match![1],
      EXPECTED_OPENCODE_VERSION,
      `${agent}/runner/Dockerfile's OPENCODE_VERSION (${match![1]}) must equal opencode.ts's EXPECTED_OPENCODE_VERSION (${EXPECTED_OPENCODE_VERSION})`,
    );
  }
});

// A deployment can point a runner image at any tag, so consistency of the
// Dockerfile default is necessary but not sufficient — the runtime
// assertRunnerVersion check (see workspace.ts) is the other half.
test("every runner installs the pinned opencode version from the build arg", async () => {
  for (const { agent, content } of await runnerDockerfiles()) {
    assert.match(content, /opencode-ai@\$\{OPENCODE_VERSION\}/, `${agent}/runner/Dockerfile must install opencode-ai@\${OPENCODE_VERSION}`);
  }
});
