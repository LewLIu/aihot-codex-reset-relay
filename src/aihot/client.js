import { parseRetryAfter } from "../utils/time.js";

export const AIHOT_CODEX_RESETS_URL = "https://aihot.news/api/v1/codex-resets";

export async function fetchCodexResets({ etag = null, fetchFn = fetch, nowMs = Date.now() } = {}) {
  const headers = new Headers({ Accept: "application/json" });
  if (etag) headers.set("If-None-Match", etag);
  let response;
  try {
    response = await fetchFn(AIHOT_CODEX_RESETS_URL, { method: "GET", headers, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    return { kind: "source_error", status: null, code: error?.name === "TimeoutError" ? "timeout" : "network_error" };
  }
  if (response.status === 304) return { kind: "not_modified" };
  if (response.status === 200) {
    try {
      return { kind: "ok", snapshot: await response.json(), etag: response.headers.get("ETag") };
    } catch {
      return { kind: "source_error", status: 200, code: "invalid_json" };
    }
  }
  const retryAt = parseRetryAfter(response.headers.get("Retry-After"), nowMs);
  return { kind: "source_error", status: response.status, code: `http_${response.status}`, retryNotBefore: retryAt };
}
