/**
 * Boundary guard — AC-8. The dependency rule is directional:
 *   platform/ imports nothing from agents/
 *   agents/X/ imports platform/ freely, but never another agents/Y/
 * This test fails the build if either rule is broken.
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

test("platform/ never imports from agents/", async () => {
  const platformDir = path.join(SRC, "platform");
  const offenders: string[] = [];
  for (const file of await tsFiles(platformDir)) {
    for (const spec of relativeImports(await readFile(file, "utf8"))) {
      const resolved = path.resolve(path.dirname(file), spec);
      if (isInside(resolved, path.join(SRC, "agents"))) {
        offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `platform must not import agents:\n${offenders.join("\n")}`);
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
