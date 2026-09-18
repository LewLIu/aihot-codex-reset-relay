import { expect, it, vi } from "vitest";
import { fetchCodexResets } from "../../src/aihot/client.js";

it("sends If-None-Match and normalizes 304", async () => {
  const fetchFn = vi.fn(async (_url, init) => {
    expect(init.headers.get("If-None-Match")).toBe('"abc"');
    return new Response(null, { status: 304 });
  });
  await expect(fetchCodexResets({ etag: '"abc"', fetchFn, nowMs: 0 })).resolves.toEqual({ kind: "not_modified" });
});

it("normalizes a successful 200 response as a snapshot", async () => {
  const snapshot = { schemaVersion: 1, checkedAt: "2026-09-17T00:00:00Z", events: [] };
  const fetchFn = vi.fn(async () => new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: '"v1"' },
  }));
  await expect(fetchCodexResets({ fetchFn, nowMs: 0 })).resolves.toEqual({
    kind: "snapshot",
    snapshot,
    etag: '"v1"',
  });
});

it("returns retryNotBefore for 503 Retry-After", async () => {
  const fetchFn = vi.fn(async () => new Response("busy", { status: 503, headers: { "Retry-After": "120" } }));
  const result = await fetchCodexResets({ fetchFn, nowMs: 1000 });
  expect(result.retryNotBefore).toBe(121000);
});
