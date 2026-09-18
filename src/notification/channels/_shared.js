export function timeoutSignal() { return AbortSignal.timeout(10_000); }
export function httpFailure(status) { return { ok:false, retryable: status === 408 || status === 429 || status >= 500, code:`http_${status}` }; }
export async function safeJson(response) { try { return await response.json(); } catch { return null; } }
export function retryAfterMs(response) { const raw=response.headers.get("Retry-After"); if(!raw) return null; if(/^\d+$/.test(raw.trim())) return Number(raw.trim())*1000; const t=Date.parse(raw); return Number.isFinite(t)?Math.max(0,t-Date.now()):null; }
