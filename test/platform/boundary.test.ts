/**
 * Boundary guard. The dependency rule is directional, three layers:
 *   platform/        imports nothing from harness/ or agents/
 *   harness/opencode imports platform/, never agents/
 *   agents/X/        imports platform/ and harness/, never another agents/Y/
 * and nothing above platform/ imports a concrete adapter (only adapter/types.ts).
 * This test fails the build if any rule is broken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(fileURLToPath(new URL("../../", import.meta.url)), "src");

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Relative import specifiers in a source file (static import/export-from). */
function relativeImports(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    if (m[1].startsWith(".")) specs.push(m[1]);
  }
  return specs;
}

/** The agent a path belongs to (e.g. "coding"), or undefined for platform/. */
function agentOf(file: string): string | undefined {
  const rel = path.relative(SRC, file).split(path.sep);
  return rel[0] === "agents" ? rel[1] : undefined;
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Files under `from` that import anything under one of `forbidden`. */
async function importsInto(from: string, forbidden: string[]): Promise<string[]> {
  const offenders: string[] = [];
  for (const file of await tsFiles(path.join(SRC, from))) {
    for (const spec of relativeImports(await readFile(file, "utf8"))) {
      const resolved = path.resolve(path.dirname(file), spec);
      if (forbidden.some((dir) => isInside(resolved, path.join(SRC, dir)))) {
        offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
      }
    }
  }
  return offenders;
}

test("platform/ never imports from harness/ or agents/", async () => {
  const offenders = await importsInto("platform", ["harness", "agents"]);
  assert.deepEqual(offenders, [], `platform must not import upward:\n${offenders.join("\n")}`);
});

test("harness/ never imports from agents/", async () => {
  const offenders = await importsInto("harness", ["agents"]);
  assert.deepEqual(offenders, [], `harness must not import agents:\n${offenders.join("\n")}`);
});

test("an agent never imports another agent", async () => {
  const agentsDir = path.join(SRC, "agents");
  const offenders: string[] = [];
  for (const file of await tsFiles(agentsDir)) {
    const own = agentOf(file);
    for (const spec of relativeImports(await readFile(file, "utf8"))) {
      const resolved = path.resolve(path.dirname(file), spec);
      const other = agentOf(resolved);
      if (other && other !== own) {
        offenders.push(`${path.relative(SRC, file)} (${own}) -> ${spec} (${other})`);
      }
    }
  }
  assert.deepEqual(offenders, [], `an agent must not import another:\n${offenders.join("\n")}`);
});

test("agents/ and harness/ never import a concrete adapter (only platform/adapter/types.ts)", async () => {
  const offenders: string[] = [];
  for (const file of [...(await tsFiles(path.join(SRC, "agents"))), ...(await tsFiles(path.join(SRC, "harness")))]) {
    for (const spec of relativeImports(await readFile(file, "utf8"))) {
      const resolved = path.resolve(path.dirname(file), spec);
      if (isInside(resolved, path.join(SRC, "platform", "adapter")) && !resolved.endsWith(path.join("adapter", "types.ts"))) {
        offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `agents may only import the adapter contract:\n${offenders.join("\n")}`);
});
