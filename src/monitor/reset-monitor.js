import { fetchCodexResets } from "../aihot/client.js";
import { validateSnapshot } from "../aihot/validate.js";
import { parseTargets } from "../config/targets.js";
import { createKvStore } from "../state/kv-store.js";
import { detectSignals } from "./signals.js";
import { sourceBackoffMs } from "../utils/time.js";
import {
  dispatchDeliveries,
  loadEligibleBacklog,
  reconcileTargets,
  defaultAdapters,
} from "../notification/dispatcher.js";

function newBackoff(prior, source, nowMs) {
  const attemptCount = (prior?.attemptCount ?? 0) + 1;
  return {
    attemptCount,
    retryNotBefore: source.retryNotBefore ?? nowMs + sourceBackoffMs(attemptCount),
    lastStatus: source.status ?? null,
    lastFailureAt: nowMs,
    reason: source.status ? `http_${source.status}` : source.code ?? "source_error",
    updatedAt: nowMs,
  };
}

function committedMeta({ source, snapshot, watermark, nowMs }) {
  return {
    stateVersion: 4,
    etag: source.etag ?? null,
    watermark,
    sourceCheckedAt: snapshot.checkedAt ?? new Date(nowMs).toISOString(),
    lastCommittedAt: new Date(nowMs).toISOString(),
  };
}

export async function runResetMonitor({
  env,
  nowMs = Date.now(),
  fetchFn = fetch,
  adapters = defaultAdapters,
  store = createKvStore(env.CODEX_RESET_STATE),
} = {}) {
  const { targets, errors } = await parseTargets(env);
  const targetsById = await reconcileTargets(store, targets, nowMs);
  let meta = await store.getMeta();
  let newSignals = [];
  const backoff = await store.getSourceBackoff();
  let sourceStatus = "backoff";

  if (!backoff || Number(backoff.retryNotBefore) <= nowMs) {
    const validV4Meta = meta?.stateVersion === 4;
    const source = await fetchCodexResets({ etag: validV4Meta ? meta?.etag ?? null : null, fetchFn, nowMs });
    sourceStatus = source.kind;

    if (source.kind === "snapshot") {
      const snapshot = validateSnapshot(source.snapshot);
      const receipts = await store.listReceiptSignals();
      const baseline = !validV4Meta || meta?.watermark == null;
      const detected = detectSignals({
        snapshot,
        meta: baseline ? null : meta,
        existingReceiptSignals: receipts,
        targetIds: [...targetsById.keys()],
      });

      if (baseline) {
        for (const signal of detected.baselineReceiptSignals) {
          await store.ensureSignal({ ...signal, targetIds: [] });
        }
      } else {
        for (const signal of detected.signals) {
          const prior = await store.getSignal(signal.signalId);
          if (!prior) {
            await store.ensureSignal(signal);
            newSignals.push(signal);
          }
        }
      }

      meta = committedMeta({ source, snapshot, watermark: detected.watermark, nowMs });
      await store.putMeta(meta);
      await store.putSourceBackoff(null);
    } else if (source.kind === "not_modified") {
      await store.putSourceBackoff(null);
    } else {
      await store.putSourceBackoff(newBackoff(backoff, source, nowMs));
    }
  }

  const backlog = await loadEligibleBacklog(store, nowMs);
  const seen = new Set();
  const work = [];
  for (const signal of newSignals) {
    for (const targetId of signal.targetIds ?? []) {
      const key = `${signal.signalId}|${targetId}`;
      seen.add(key);
      work.push({ signal, targetId });
    }
  }
  for (const item of backlog) {
    const key = `${item.signal.signalId}|${item.targetId}`;
    if (!seen.has(key)) work.push(item);
  }

  const delivery = await dispatchDeliveries({
    work,
    targetsById,
    store,
    adapters,
    attemptBudget: 10,
    concurrency: 3,
    nowMs,
    fetchFn,
  });

  const diagnostics = {
    status: "ok",
    sourceStatus,
    lastCheck: new Date(nowMs).toISOString(),
    targetCount: targets.length,
    configErrorCount: errors.length,
    deliveryAttempts: delivery.attempts,
  };
  await store.putDiagnostics(diagnostics);
  return diagnostics;
}
