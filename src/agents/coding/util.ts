/**
 * Coding-agent helpers — repo parsing and shell quoting.
 */

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

/**
 * Single-quote a value for POSIX sh so it reaches git as one argv even when it
 * contains spaces or quotes (e.g. a git author name: `git config --global
 * user.name 'Jean-Marc « JM »'`).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
