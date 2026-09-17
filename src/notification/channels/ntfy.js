import { neutralizeMentions, truncateText } from "../../utils/text.js";
import { httpFailure, timeoutSignal, retryAfterMs } from "./_shared.js";

export function encodeRfc2047(value) {
  const text = String(value ?? "");
  if ([...text].every((character) => character.charCodeAt(0) <= 0x7f)) return text;
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

export async function send(target, note, { fetchFn = fetch } = {}) {
  const server = String(target.config.server ?? "https://ntfy.sh").replace(/\/+$/, "");
  const url = `${server}/${encodeURIComponent(target.config.topic)}`;
  const headers = new Headers({
    "Content-Type": "text/plain; charset=utf-8",
    Title: encodeRfc2047(truncateText(neutralizeMentions(note.title ?? "Codex Reset"), 200)),
  });
  if (target.config.token) headers.set("Authorization", `Bearer ${target.config.token}`);

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body: truncateText(neutralizeMentions(note.content ?? ""), 4000),
      signal: timeoutSignal(),
    });
    return response.ok
      ? { ok: true }
      : { ...httpFailure(response.status), retryAfterMs: retryAfterMs(response) };
  } catch (error) {
    return { ok: false, retryable: true, code: error?.name === "TimeoutError" ? "timeout" : "network" };
  }
}
