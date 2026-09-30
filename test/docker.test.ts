/**
 * Unit tests for the compose driver's pure mappings (src/docker.ts), driven
 * through a fake execFile — no docker daemon, no k8s, no filesystem outside
 * a temp dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

// The driver reads its env-file directory (and the runner image / broker
// name) at import time — set the test values BEFORE the dynamic import below.
process.env.ROOMS_ENV_DIR = await mkdtemp(path.join(tmpdir(), "alveole-docker-test-"));
process.env.RUNNER_IMAGE = "alveole-runner:test";
process.env.BROKER_CONTAINER_NAME = "alveole-broker-test";

const docker = await import("../src/docker.ts");
const { parseEnvFile, envFileContent, inspectStateToRoomPodState, roomNetworkName, roomEnvFilePath, roomResourceName, readRoomPodState, waitForRunning, getRoomServerPassword, provisionRoom, teardownRoom, setDockerExecForTests } = docker;

test("roomResourceName re-export is a valid docker container name", () => {
  const name = roomResourceName("! projeté très très long ".repeat(5) + "🔥");
  assert.match(name, /^[a-z0-9][a-z0-9_.-]*$/); // docker container-name charset
  assert.ok(name.length <= 63);
  assert.ok(name.startsWith("room-"));
  assert.equal(name, roomResourceName("! projeté très très long ".repeat(5) + "🔥")); // stable
  assert.notEqual(roomResourceName("roomA", "dev"), roomResourceName("roomB", "dev"));
});

test("parseEnvFile: comments, blanks, and values containing '='", () => {
  const env = parseEnvFile(
    [
      "# a comment",
      "",
      "REPO=owner/name",
      "GH_TOKEN=ghp_ab==",
      "OPENCODE_SERVER_PASSWORD=with spaces trimmed",
    ].join("\n"),
  );
  assert.deepEqual(env, {
    REPO: "owner/name",
    GH_TOKEN: "ghp_ab==", // '=' inside a value survives: split on the FIRST '='
    OPENCODE_SERVER_PASSWORD: "with spaces trimmed",
  });
});

test("envFileContent round-trips through parseEnvFile", () => {
  const values = { REPO: "owner/name", GH_TOKEN: "token=with==padding", OPENCODE_SERVER_PASSWORD: "a".repeat(32), OPENROUTER_API_KEY: "sk-or-x" };
  assert.deepEqual(parseEnvFile(envFileContent(values)), values);
});

test("inspect state -> RoomPodState mapping mirrors k8s.ts semantics", () => {
  assert.equal(inspectStateToRoomPodState(undefined), "gone");
  assert.equal(inspectStateToRoomPodState({ Status: "running", Running: true }), "running");
  assert.equal(inspectStateToRoomPodState({ Status: "created" }), "pending");
  assert.equal(inspectStateToRoomPodState({ Status: "restarting" }), "pending");
  assert.equal(inspectStateToRoomPodState({ Status: "paused" }), "pending");
  assert.equal(inspectStateToRoomPodState({ Status: "exited", ExitCode: 1 }), "failed");
  assert.equal(inspectStateToRoomPodState({ Status: "dead" }), "failed");
  assert.equal(inspectStateToRoomPodState({ Status: "removing" }), "gone"); // like k8s Terminating
});

test("readRoomPodState maps docker inspect output through the fake exec", async () => {
  setDockerExecForTests(async (_file, args) => {
    assert.equal(args[0], "inspect");
    return { stdout: JSON.stringify({ Status: "running", Running: true }), stderr: "" };
  });
  assert.equal(await readRoomPodState("room-x"), "running");

  // Out-of-band deletion (docker rm from outside, host reboot): not-found CLI
  // error on stderr -> "gone", not a thrown failure.
  setDockerExecForTests(async () => {
    throw new Error("docker inspect --format {{json .State}} room-x failed: Error: No such container: room-x");
  });
  assert.equal(await readRoomPodState("room-x"), "gone");

  // A real CLI failure (daemon down, socket perms) still throws — the caller
  // treats it like the k8s pod-read failure, not as a dead pod.
  setDockerExecForTests(async () => {
    throw new Error("docker inspect ... failed: Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
  });
  await assert.rejects(readRoomPodState("room-x"), /Cannot connect/);

  setDockerExecForTests(undefined);
});

test("waitForRunning resolves on the first Running poll", async () => {
  setDockerExecForTests(async () => ({ stdout: JSON.stringify({ Status: "running", Running: true, Error: "" }), stderr: "" }));
  await waitForRunning("room-x", 100);
  setDockerExecForTests(undefined);
});

test("waitForRunning throws immediately on an exited container (FATAL_WAIT_REASONS equivalent)", async () => {
  setDockerExecForTests(async () => ({ stdout: JSON.stringify({ Status: "exited", Running: false, ExitCode: 127, Error: "" }), stderr: "" }));
  await assert.rejects(waitForRunning("room-x", 60_000), /cannot start: exit code 127/);
});

test("waitForRunning throws immediately on a container-level error", async () => {
  setDockerExecForTests(async () => ({ stdout: JSON.stringify({ Status: "created", Running: false, Error: "oci runtime error: no such image config" }), stderr: "" }));
  await assert.rejects(waitForRunning("room-x", 60_000), /oci runtime error/);
});

test("waitForRunning hits the deadline when the container stays pending", async () => {
  setDockerExecForTests(async () => ({ stdout: JSON.stringify({ Status: "created", Running: false, Error: "" }), stderr: "" }));
  await assert.rejects(waitForRunning("room-x", 50), /did not become Running within 50ms/);
  setDockerExecForTests(undefined);
});

test("getRoomServerPassword reads the persisted env file", async () => {
  await writeFile(roomEnvFilePath("room-pw"), envFileContent({ REPO: "o/r", GH_TOKEN: "t", OPENCODE_SERVER_PASSWORD: "abc123", OPENROUTER_API_KEY: "k" }));
  assert.equal(await getRoomServerPassword("room-pw"), "abc123");
  await rm(roomEnvFilePath("room-pw"));
  await assert.rejects(getRoomServerPassword("room-pw"), /no OPENCODE_SERVER_PASSWORD/);
});

test("provisionRoom reuses the existing password and never recreates a running container", async () => {
  const name = "room-idem";
  const calls: string[][] = [];
  let inspectCalls = 0;
  setDockerExecForTests(async (_file, args) => {
    calls.push(args);
    if (args[0] === "inspect") {
      inspectCalls++;
      // First provision: no container yet; second provision: already running.
      if (inspectCalls === 1) {
        throw new Error(`docker inspect ... failed: Error: No such container: ${name}`);
      }
      return { stdout: JSON.stringify({ Status: "running", Running: true }), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });

  const password1 = await provisionRoom(name, { repo: "o/r", token: "t", openrouterKey: "k" }, "rules");
  const password2 = await provisionRoom(name, { repo: "o/r", token: "t", openrouterKey: "k" }, "rules");
  assert.equal(password1, password2); // password reused, never regenerated

  const runs = calls.filter((args) => args[0] === "run");
  assert.equal(runs.length, 1); // second provision left the running container alone
  const run = runs[0];
  assert.deepEqual(
    [
      "run", "-d", "--name", name,
      "--network", `room-${name}`,
      "--env-file", roomEnvFilePath(name),
      "--memory", "2g", "--cpus", "2",
      "--restart", "no", "--label", `alveole.room=${name}`,
    ].map(String),
    run.slice(0, 16),
  );
  assert.deepEqual(run.slice(16), ["-e", "AGENT_RULES=rules", "alveole-runner:test"]);

  // env file holds the same password and is the driver's password store
  assert.equal(await getRoomServerPassword(name), password1);

  setDockerExecForTests(undefined);
});

test("provisionRoom recreates a dead container and reuses its password", async () => {
  const name = "room-dead";
  const calls: string[][] = [];
  let inspected = 0;
  setDockerExecForTests(async (_file, args) => {
    calls.push(args);
    if (args[0] === "inspect") {
      inspected++;
      if (inspected === 1) throw new Error(`no such container: ${name}`);
      return { stdout: JSON.stringify({ Status: "exited", Running: false, ExitCode: 1 }), stderr: "" }; // dead runner
    }
    return { stdout: "", stderr: "" };
  });

  const password = await provisionRoom(name, { repo: "o/r", token: "t", openrouterKey: "k" });
  assert.equal(calls.filter((args) => args[0] === "run").length, 1); // fresh create: no container existed, nothing to remove
  const second = await provisionRoom(name, { repo: "o/r", token: "t", openrouterKey: "k" });
  assert.ok(calls.some((args) => args[0] === "rm" && args[1] === "-f" && args[2] === name)); // dead one removed...
  assert.equal(calls.filter((args) => args[0] === "run").length, 2); // ...then recreated
  assert.equal(second, password); // same env file -> same password

  // teardown removes container + network + env file and tolerates not-found
  calls.length = 0;
  setDockerExecForTests(async (_file, args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "rm") throw new Error(`docker network rm failed: Error: No such network: ${args[2]}`);
    return { stdout: "", stderr: "" };
  });
  await teardownRoom(name);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2).join(" ")),
    ["rm -f", "network disconnect", "network rm"],
  );
  await assert.rejects(getRoomServerPassword(name), /no OPENCODE_SERVER_PASSWORD/); // env file deleted

  setDockerExecForTests(undefined);
});
