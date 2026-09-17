const MASS_MENTION = /@(everyone|channel|here|all)\b/gi;
export function neutralizeMentions(value) { return String(value ?? "").replace(MASS_MENTION, (_m, n) => `@\u200b${n}`); }
export function escapeHtml(value) { return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
export function escapeMrkdwn(value) { return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
export function escapeMarkdown(value) { return String(value ?? "").replace(/([\\`*_{}\[\]()#+\-.!|>])/g,"\\$1"); }
export function safeHttpUrl(value) { if (!value) return null; try { const u=new URL(String(value)); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null; } catch { return null; } }
export function truncateText(value, max=3500) { const text=String(value ?? ""); return text.length <= max ? text : `${text.slice(0, Math.max(0,max-1))}…`; }
export function plainText(note) { return truncateText(neutralizeMentions([note.title, note.content, safeHttpUrl(note.sourceUrl)].filter(Boolean).join("\n\n"))); }
