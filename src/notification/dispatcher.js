import * as wework from "./channels/wework.js";
import * as feishu from "./channels/feishu.js";
import * as dingtalk from "./channels/dingtalk.js";
import * as telegram from "./channels/telegram.js";
import * as bark from "./channels/bark.js";
import * as ntfy from "./channels/ntfy.js";
import * as slack from "./channels/slack.js";
import * as generic from "./channels/generic-webhook.js";
import { classifyDeliveryFailure } from "./retry.js";

export const defaultAdapters = {
  wework,
  feishu,
  dingtalk,
  telegram,
  bark,
  ntfy,
  slack,
  "generic-webhook": generic,
};

export async function reconcileTargets(store, targets, nowMs) {
  const active = new Map(targets.map((target) => [target.id, target]));

  for (const target of targets) {
    const old = await store.getTargetRecord(target.id);
    if (!old || old.status !== "active") {
      await store.putTargetRecord(target.id, {
        targetId: target.id,
        channel: target.channel,
        status: "active",
        enabledAt: old?.enabledAt ?? nowMs,
        disabledAt: null,
      });
    }
  }

  for (const old of await store.listTargetRecords()) {
    const targetId = old.targetId;
    if (!targetId || old.status !== "active" || active.has(targetId)) continue;

    await store.putTargetRecord(targetId, { ...old, status: "disabled", disabledAt: nowMs });
    for (const signal of await store.listSignals()) {
      if (!(signal.targetIds ?? []).includes(targetId)) continue;
      const delivery = await store.getDelivery(signal.signalId, targetId);
      if (!delivery || delivery.status === "retry_wait") {
        await store.putDelivery(signal.signalId, targetId, {
          status: "disabled",
          attemptCount: delivery?.attemptCount ?? 0,
          lastAttemptAt: nowMs,
        });
      }
    }
  }

  return active;
}

export async function loadEligibleBacklog(store, nowMs) {
  const out = [];
  for (const signal of await store.listSignals()) {
    for (const targetId of signal.targetIds ?? []) {
      const delivery = await store.getDelivery(signal.signalId, targetId);
      if (!delivery || (delivery.status === "retry_wait" && Number(delivery.nextAttemptAt ?? 0) <= nowMs)) {
        out.push({ signal, targetId });
      }
    }
  }
  return out;
}

export async function dispatchDeliveries({
  work,
  targetsById,
  store,
  adapters = defaultAdapters,
  attemptBudget = 10,
  concurrency = 3,
  nowMs = Date.now(),
  fetchFn = fetch,
}) {
  const streams = new Map();
  for (const item of work) {
    if (!streams.has(item.targetId)) streams.set(item.targetId, []);
    streams.get(item.targetId).push(item);
  }
  for (const items of streams.values()) {
    items.sort((a, b) => String(a.signal.sortAt).localeCompare(String(b.signal.sortAt)) || a.signal.signalId.localeCompare(b.signal.signalId));
  }

  const queue = [...streams.entries()];
  let attempts = 0;
  const results = [];

  async function run() {
    while (queue.length) {
      const [targetId, items] = queue.shift();
      for (const item of items) {
        if (attempts >= attemptBudget) return;
        const target = targetsById.get(targetId);
        if (!target) {
          const delivery = await store.getDelivery(item.signal.signalId, targetId);
          if (!delivery || delivery.status === "retry_wait") {
            await store.putDelivery(item.signal.signalId, targetId, {
              status: "disabled",
              attemptCount: delivery?.attemptCount ?? 0,
              lastAttemptAt: nowMs,
            });
          }
          continue;
        }

        const prior = await store.getDelivery(item.signal.signalId, targetId);
        if (
          prior?.status === "sent" ||
          prior?.status === "permanent_failure" ||
          prior?.status === "disabled" ||
          (prior?.status === "retry_wait" && prior.nextAttemptAt > nowMs)
        ) continue;

        attempts += 1;
        const adapter = adapters[target.channel];
        const result = adapter
          ? await adapter.send(target, { ...item.signal.notification, signalId: item.signal.signalId }, { fetchFn })
          : { ok: false, retryable: false, code: "unsupported_channel" };

        if (result.ok) {
          await store.putDelivery(item.signal.signalId, targetId, {
            status: "sent",
            attemptCount: (prior?.attemptCount ?? 0) + 1,
            sentAt: nowMs,
            lastAttemptAt: nowMs,
          });
        } else {
          await store.putDelivery(
            item.signal.signalId,
            targetId,
            classifyDeliveryFailure(result, (prior?.attemptCount ?? 0) + 1, nowMs),
          );
        }
        results.push({ signalId: item.signal.signalId, targetId, ok: result.ok });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => run()));
  return { attempts, results };
}
