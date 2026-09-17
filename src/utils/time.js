export function parseIsoMs(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("invalid_timestamp");
  return ms;
}

export function parseRetryAfter(value, nowMs) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return nowMs + Number(text) * 1000;
  const absolute = Date.parse(text);
  return Number.isFinite(absolute) ? absolute : null;
}

export function sourceBackoffMs(attemptCount) {
  const sequence = [5, 10, 20, 40, 80, 160, 320].map((m) => m * 60_000);
  return sequence[Math.min(Math.max(attemptCount, 1) - 1, sequence.length - 1)] ?? 6 * 60 * 60_000;
}
