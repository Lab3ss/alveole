/**
 * Docker integration test — only runs with RUN_DOCKER_TESTS=1 (needs a docker
 * daemon and enough network to pull `alpine`). Exercises the full compose
 * driver lifecycle against the real CLI: provision -> waitForRunning ->
 * getRoomServerPassword -> readRoomPodState=running -> teardown ->
 * readRoomPodState=gone. Uses a throwaway sleep-forever image (the real
 * runner image would need a valid GH_TOKEN to survive its entrypoint), with
 * env files redirected to a temp dir so the host /data is never touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const enabled = process.env.RUN_DOCKER_TESTS === "1";

test(
  "compose driver lifecycle against a real docker daemon",
  { skip: enabled ? false : "set RUN_DOCKER_TESTS=1 with a docker daemon to run" },
  async () => {
    const envDir = await mkdtemp(path.join(tmpdir(), "alveole-docker-it-"));
    process.env.ROOMS_ENV_DIR = envDir;
    process.env.RUNNER_IMAGE = "alveole-test-runner:sleep";
    // No broker container exists on the host — provision's broker attach must
    // warn-and-continue (production compose always has the broker container).
    process.env.BROKER_CONTAINER_NAME = "alveole-broker-does-not-exist-in-this-test";

    const docker = await import("../../../src/agents/coding/docker.ts");

    // Tiny stand-in runner whose entrypoint just sleeps: no GH_TOKEN needed.
    const buildDir = await mkdtemp(path.join(tmpdir(), "alveole-docker-it-img-"));
    await writeFile(path.join(buildDir, "Dockerfile"), "FROM alpine:3\nCMD [\"sleep\", \"3600\"]\n");
    await new Promise<void>((resolve, reject) => {
      execFile("docker", ["build", "-q", "-t", "alveole-test-runner:sleep", buildDir], (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message)));
        else resolve();
      });
    });

    const name = docker.roomResourceName("integration-test-room-" + Date.now(), "docker it");
    try {
      const password = await docker.provisionRoom(name, { repo: "owner/name", token: "unused-by-test-image", openrouterKey: "unused" });
      assert.match(password, /^[0-9a-f]{32}$/);

      await docker.waitForRunning(name);
      assert.equal(await docker.getRoomServerPassword(name), password);
      assert.equal(await docker.readRoomPodState(name), "running");

      await docker.teardownRoom(name);
      assert.equal(await docker.readRoomPodState(name), "gone");
    } finally {
      await docker.teardownRoom(name).catch(() => {}); // leave nothing behind on failure
      await rm(envDir, { recursive: true, force: true });
      await rm(buildDir, { recursive: true, force: true });
    }
  },
);
