import { expect, it, vi } from "vitest";
import { runResetMonitor } from "../../src/monitor/reset-monitor.js";

function makeStore() {
  const signals = new Map();
  let meta = null;
  return {
    signals,
    getTargetRecord: vi.fn(async () => null),
    putTargetRecord: vi.fn(async () => {}),
    listTargetRecords: vi.fn(async () => []),
    getMeta: vi.fn(async () => meta),
    putMeta: vi.fn(async (value) => { meta = value; }),
    getSourceBackoff: vi.fn(async () => null),
    putSourceBackoff: vi.fn(async () => {}),
    listReceiptSignals: vi.fn(async () => [...signals.values()].filter((signal) => signal.kind === "receipt_review")),
    getSignal: vi.fn(async (signalId) => signals.get(signalId) ?? null),
    ensureSignal: vi.fn(async (signal) => { signals.set(signal.signalId, signal); return signal; }),
    listSignals: vi.fn(async () => [...signals.values()]),
    getDelivery: vi.fn(async () => null),
    putDelivery: vi.fn(async () => {}),
    putDiagnostics: vi.fn(async () => {}),
  };
}

it("baselines existing receipt reviews without creating historical delivery work", async () => {
  const store = makeStore();
  const snapshot = {
    schemaVersion: 1,
    checkedAt: "2026-09-17T00:00:00Z",
    events: [{
      id: "event-1",
      type: "direct_reset",
      status: "confirmed",
      confirmationBasis: "receipt_review",
      title: "Reset confirmed",
      scope: "all",
      updatedAt: "2026-09-17T00:00:00Z",
      posts: [{ id: "post-1", publishedAt: "2026-09-16T23:00:00Z", text: "announcement", url: "https://example.test/post-1" }],
      url: "https://aihot.news/codex-reset",
    }],
  };
  const fetchFn = vi.fn(async () => new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: '"v1"' },
  }));

  await runResetMonitor({ env: {}, store, fetchFn, nowMs: Date.parse("2026-09-17T00:01:00Z") });

  const receipt = store.signals.get("receipt_review:direct_reset:post-1");
  expect(receipt).toBeTruthy();
  expect(receipt.targetIds).toEqual([]);
  expect(store.putDelivery).not.toHaveBeenCalled();
  expect(store.putMeta).toHaveBeenCalledWith(expect.objectContaining({
    stateVersion: 4,
    etag: '"v1"',
  }));
});
