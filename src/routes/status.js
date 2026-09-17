import { parseTargets } from "../config/targets.js";
import { createKvStore } from "../state/kv-store.js";
async function pendingSummary(store) {
  const counts = { pending: 0, retry_wait: 0, permanent_failure: 0, disabled: 0 };
  for (const signal of await store.listSignals()) for (const targetId of signal.targetIds ?? []) { const delivery = await store.getDelivery(signal.signalId, targetId); if (!delivery) counts.pending += 1; else if (delivery.status in counts) counts[delivery.status] += 1; }
  return counts;
}
export async function handleStatus(_request, env, { store = createKvStore(env.CODEX_RESET_STATE) } = {}) {
  const { targets, errors } = await parseTargets(env); const meta = await store.getMeta(); const diag = await store.getDiagnostics(); const channels = {};
  for (const target of targets) channels[target.channel] = (channels[target.channel] ?? 0) + 1;
  return Response.json({ service: "aihot-codex-reset-relay", version: "1.0.0", source: "AIHOT Codex Reset API", schedule: "*/30 * * * *", sourceCheckedAt: meta?.sourceCheckedAt ?? null, latestPublishedAt: meta?.watermark?.publishedAt ?? null, lastCheck: diag?.lastCheck ?? null, lastCronStatus: diag?.status ?? null, channels, configuredTargets: targets.length, configErrorCount: errors.length, deliveries: await pendingSummary(store) });
}
export async function handleHealth(_request, env, { store = createKvStore(env.CODEX_RESET_STATE) } = {}) { const diag = await store.getDiagnostics(); const ok = !diag || diag.status === "ok"; return Response.json({ ok, service: "aihot-codex-reset-relay", lastCheck: diag?.lastCheck ?? null }, { status: ok ? 200 : 503 }); }
