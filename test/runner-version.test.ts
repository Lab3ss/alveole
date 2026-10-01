import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EXPECTED_OPENCODE_VERSION } from "../src/opencode.ts";

// The broker's HTTP contract targets exactly one opencode version (see
// src/opencode.ts). runner/Dockerfile is the other place that version lives, so
// this test is what keeps the two from silently drifting apart — a drift is a
// moved route/event that, at runtime, errors confusingly (or not at all).
test("runner/Dockerfile pins the opencode version the broker expects", async () => {
  const dockerfile = await readFile(new URL("../runner/Dockerfile", import.meta.url), "utf8");
  const match = dockerfile.match(/^\s*ARG\s+OPENCODE_VERSION=(\S+)/m);
  assert.ok(match, "runner/Dockerfile must declare ARG OPENCODE_VERSION=<version>");
  assert.equal(
    match![1],
    EXPECTED_OPENCODE_VERSION,
    `runner/Dockerfile's OPENCODE_VERSION (${match![1]}) must equal opencode.ts's EXPECTED_OPENCODE_VERSION (${EXPECTED_OPENCODE_VERSION})`,
  );
});

// A deployment can point RUNNER_IMAGE at any tag, so consistency of the
// Dockerfile default is necessary but not sufficient — the runtime
// assertRunnerVersion check (see src/core/workspace.ts) is the other half.
test("runner entrypoint installs the pinned opencode version from the build arg", async () => {
  const dockerfile = await readFile(new URL("../runner/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /opencode-ai@\$\{OPENCODE_VERSION\}/);
});
