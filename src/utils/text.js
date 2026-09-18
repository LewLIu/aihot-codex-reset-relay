const MASS_MENTION = /@(everyone|channel|here|all)\b/gi;
const MARKDOWN_SPECIAL = new Set("\\`*_{}[]()#+-.!|>");

export function neutralizeMentions(value) {
  return String(value ?? "").replace(MASS_MENTION, (_match, name) => `@\u200b${name}`);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function escapeMrkdwn(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeMarkdown(value) {
  return [...String(value ?? "")]
    .map((character) => MARKDOWN_SPECIAL.has(character) ? `\\${character}` : character)
    .join("");
}

export function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function truncateText(value, max = 3500) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function plainText(note) {
  return truncateText(
    neutralizeMentions([note.title, note.content, safeHttpUrl(note.sourceUrl)].filter(Boolean).join("\n\n")),
  );
}
