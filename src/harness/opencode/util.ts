/**
 * Harness helpers — rendering of opencode's session usage. Depends on
 * opencode's SessionUsage, so it belongs to the harness, not the platform.
 */
import type { SessionUsage } from "./opencode.ts";

export function formatUsage(usage: SessionUsage): string {
  const cost = typeof usage.cost === "number" ? `$${usage.cost.toFixed(4)}` : "n/a (not reported for this model)";
  const t = usage.tokens;
  const tokens = t
    ? `in: ${t.input} · out: ${t.output} · reasoning: ${t.reasoning} · cache read: ${t.cache.read} · cache write: ${t.cache.write}`
    : "n/a";
  const context = usage.compactedAt ? `compacted at ${new Date(usage.compactedAt).toLocaleString()}` : "not compacted";
  return `📊 Usage for this session\n💰 Cost: ${cost}\n🔢 Tokens — ${tokens}\n🗜️ Context: ${context}`;
}
