import { expect, it, vi } from "vitest";
import { encodeRfc2047, send } from "../../src/notification/channels/ntfy.js";

it("RFC2047 encodes unicode titles for Headers-compatible transport", () => {
  const value = encodeRfc2047("重置通知");
  expect(value).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  expect(() => new Headers({ Title: value })).not.toThrow();
});

it("uses an ASCII-safe Title header when sending Unicode titles", async () => {
  const fetchFn = vi.fn(async (_url, init) => {
    const title = init.headers.get("Title");
    expect(title).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect([...title].every((ch) => ch.charCodeAt(0) <= 0x7f)).toBe(true);
    return new Response("ok", { status: 200 });
  });

  await expect(send(
    { config: { server: "https://ntfy.example", topic: "codex", token: null } },
    { title: "Codex 重置提醒", content: "测试内容" },
    { fetchFn },
  )).resolves.toEqual({ ok: true });
});
