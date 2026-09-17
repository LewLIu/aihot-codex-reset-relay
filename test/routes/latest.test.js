import { expect, it, vi } from "vitest";
import { handleLatest } from "../../src/routes/latest.js";

function baseStore() {
  return {
    async getManualLatest() { return null; },
    async putManualLatest() {},
    async getSourceBackoff() { return null; },
    async putSourceBackoff() {},
  };
}

it("rejects bad key before upstream", async () => {
  const fetchFn = vi.fn();
  const response = await handleLatest(
    new Request("https://w/latest?key=x"),
    { LATEST_ACCESS_KEY: "secret" },
    { fetchFn, store: baseStore(), nowMs: 0 },
  );
  expect(response.status).toBe(403);
  expect(fetchFn).not.toHaveBeenCalled();
});

it("HEAD and prefetch are side-effect free", async () => {
  const fetchFn = vi.fn();
  expect((await handleLatest(
    new Request("https://w/latest?key=secret", { method: "HEAD" }),
    { LATEST_ACCESS_KEY: "secret" },
    { fetchFn, store: baseStore() },
  )).status).toBe(204);
  expect((await handleLatest(
    new Request("https://w/latest?key=secret", { headers: { "Sec-Purpose": "prefetch" } }),
    { LATEST_ACCESS_KEY: "secret" },
    { fetchFn, store: baseStore() },
  )).status).toBe(204);
  expect(fetchFn).not.toHaveBeenCalled();
});

it("runs a fresh AIHOT-to-adapter test without touching automatic state", async () => {
  const snapshot = {
    schemaVersion: 1,
    checkedAt: "2026-09-17T01:00:00Z",
    events: [{
      id: "event-1",
      type: "direct_reset",
      status: "confirmed",
      title: "Reset",
      scope: "all",
      updatedAt: "2026-09-17T01:00:00Z",
      posts: [{
        id: "post-1",
        publishedAt: "2026-09-17T00:59:00Z",
        text: "latest reset",
        url: "https://example.test/post-1",
      }],
      url: "https://aihot.news/codex-reset",
    }],
  };
  const fetchFn = vi.fn(async () => new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: '"latest"' },
  }));
  const send = vi.fn(async () => ({ ok: true }));
  const store = {
    ...baseStore(),
    putManualLatest: vi.fn(async () => {}),
    putSourceBackoff: vi.fn(async () => {}),
    putMeta: vi.fn(async () => { throw new Error("automatic meta must not be touched"); }),
    ensureSignal: vi.fn(async () => { throw new Error("automatic signals must not be touched"); }),
    putDelivery: vi.fn(async () => { throw new Error("automatic deliveries must not be touched"); }),
  };
  const env = {
    LATEST_ACCESS_KEY: "secret",
    GENERIC_WEBHOOK_URL: "https://hooks.example.test/reset",
  };

  const response = await handleLatest(
    new Request("https://w/latest?key=secret"),
    env,
    { fetchFn, store, adapters: { "generic-webhook": { send } }, nowMs: Date.parse("2026-09-17T01:01:00Z") },
  );
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.post).toEqual({ id: "post-1", publishedAt: "2026-09-17T00:59:00Z" });
  expect(send).toHaveBeenCalledTimes(1);
  expect(store.putMeta).not.toHaveBeenCalled();
  expect(store.ensureSignal).not.toHaveBeenCalled();
  expect(store.putDelivery).not.toHaveBeenCalled();
});
