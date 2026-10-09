/**
 * Coding-agent helpers — repo parsing, shell quoting, usage rendering. The
 * last one depends on opencode's SessionUsage, so it belongs to this agent,
 * not the platform.
 */
import type { SessionUsage } from "./opencode.ts";

export function parseRepo(text: string): string | null {
  // Find a GitHub URL anywhere in the message — users paste it mid-sentence,
  // with /tree/<branch>, /blob/<path>, a .git suffix, or trailing punctuation
  // ("clone https://github.com/a/b/tree/main please", "see https://github.com/a/b).").
  const url = text.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/[^\s]*)?(?=$|[\s.,;!?:)])/i);
  if (url) return url[1];
  const t = text.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) return t;
  return null;
}

export function formatUsage(usage: SessionUsage): string {
  const cost = typeof usage.cost === "number" ? `$${usage.cost.toFixed(4)}` : "n/a (not reported for this model)";
  const t = usage.tokens;
  const tokens = t
    ? `in: ${t.input} · out: ${t.output} · reasoning: ${t.reasoning} · cache read: ${t.cache.read} · cache write: ${t.cache.write}`
    : "n/a";
  const context = usage.compactedAt ? `compacted at ${new Date(usage.compactedAt).toLocaleString()}` : "not compacted";
  return `📊 Usage for this session\n💰 Cost: ${cost}\n🔢 Tokens — ${tokens}\n🗜️ Context: ${context}`;
}

/**
 * Single-quote a value for POSIX sh so it reaches git as one argv even when it
 * contains spaces or quotes (e.g. a git author name: `git config --global
 * user.name 'Jean-Marc « JM »'`).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
