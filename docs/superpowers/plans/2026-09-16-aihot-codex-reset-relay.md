# AIHOT Codex Reset Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted Cloudflare Worker that monitors AIHOT Codex Reset snapshots, persists immutable signals and per-target delivery state in Workers KV, retries failures safely, supports eight notification channels, and exposes authenticated one-tap `GET /latest` testing.

**Architecture:** ES-module JavaScript on Cloudflare Workers. Pure domain modules validate AIHOT snapshots and derive deterministic signals; Workers KV stores separate `meta`, `signal`, `delivery`, `target`, source-backoff, manual-cooldown, and diagnostics keys. Notification adapters consume one canonical notification model, while a dispatcher enforces three concurrent target streams and serial ordering inside each target.

**Tech Stack:** JavaScript ES modules, Cloudflare Workers + Workers KV, Wrangler 4, Vitest 4.1+ with `@cloudflare/vitest-plugin`, ESLint 9, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-16-aihot-reset-relay-design.md`

## Global Constraints

- AIHOT endpoint: `https://aihot.news/api/v1/codex-resets`.
- Cron: `*/30 * * * *`.
- Workers KV binding: `CODEX_RESET_STATE`.
- Expected AIHOT `schemaVersion`: `1`.
- Source signal ID: `post:<post.id>`.
- Receipt signal ID: `receipt_review:<event.type>:<anchorPostId>` plus source-post-overlap dedupe.
- Boundary watermark: `{ publishedAt, postIdsAtPublishedAt[] }`; every snapshot uses one immutable entry W0.
- `signal:*` is immutable; missing `delivery:<signalId>:<targetId>` means pending.
- Never collapse physical state into one hot KV key and never add sleeps to work around same-key limits.
- Delivery is at-least-once; crash-before-ack and stale-KV overlap duplicate windows are accepted/documented.
- Delivery retry: 30m → 1h → 2h → 4h → 8h → 16h → 24h → 24h; eighth failed retryable attempt becomes `permanent_failure`.
- Source backoff without `Retry-After`: 5m → 10m → 20m → 40m → 80m → 160m → 320m → 6h.
- Automatic delivery budget: 10 attempts per Cron invocation.
- Concurrency: at most 3 target streams; one target's signals are serial by `(sortAt, signalId)`.
- All AIHOT/channel HTTP calls have a 10-second timeout.
- `/latest` remains GET, requires `LATEST_ACCESS_KEY`, and checks speculative-request guards, auth, cooldown, and source backoff before AIHOT.
- `/latest` may update only `manual:latest` and shared source-backoff operational state; it never mutates automatic signals/deliveries/ETag/watermark.
- AIHOT content is untrusted; escape markup, neutralize mass mentions, filter URLs, and validate platform business success.
- V3→V4 is baseline migration; unreconstructable legacy pending intent is abandoned with `legacy_pending_abandoned` diagnostics.
- V1 excludes Durable Objects, email, admin UI, SaaS, and automatic deployment.

---

## File Map

```text
.github/workflows/ci.yml
src/index.js
src/config/targets.js
src/aihot/client.js
src/aihot/validate.js
src/aihot/latest.js
src/monitor/signals.js
src/monitor/reset-monitor.js
src/state/kv-store.js
src/notification/message.js
src/notification/retry.js
src/notification/dispatcher.js
src/notification/channels/wework.js
src/notification/channels/feishu.js
src/notification/channels/dingtalk.js
src/notification/channels/telegram.js
src/notification/channels/bark.js
src/notification/channels/ntfy.js
src/notification/channels/slack.js
src/notification/channels/generic-webhook.js
src/routes/status.js
src/routes/latest.js
src/utils/crypto.js
src/utils/text.js
src/utils/time.js
test/fixtures/aihot-response.json
test/**/*.test.js
vitest.config.js
eslint.config.js
wrangler.jsonc
package.json
.gitignore
README.md
README_EN.md
LICENSE
```

---

### Task 1: Scaffold Worker tooling and runtime

**Files:**
- Create: `package.json`
- Create: `wrangler.jsonc`
- Create: `vitest.config.js`
- Create: `eslint.config.js`
- Create: `.gitignore`
- Create: `src/index.js`
- Test: `test/smoke.test.js`

**Interfaces:**
- Produces Worker default export with `fetch(request, env, ctx)` and `scheduled(controller, env, ctx)`.
- Produces KV binding `env.CODEX_RESET_STATE`.

- [ ] **Step 1: Initialize tooling**

```bash
npm init -y
npm pkg set type=module
npm pkg set scripts.test="vitest run"
npm pkg set scripts.test:watch="vitest"
npm pkg set scripts.lint="eslint ."
npm pkg set scripts.dev="wrangler dev"
npm pkg set scripts.deploy="wrangler deploy"
npm i -D wrangler@4 vitest@^4.1.0 @cloudflare/vitest-plugin@latest eslint@^9 @eslint/js@^9 globals@latest
```

- [ ] **Step 2: Write the failing smoke test**

`test/smoke.test.js`:

```js
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

describe("worker scaffold", () => {
  it("exports fetch and scheduled handlers", () => {
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
  });
});
```

Run `npm test -- test/smoke.test.js` and expect failure because `src/index.js` does not exist.

- [ ] **Step 3: Add configuration and minimal Worker**

`wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "aihot-codex-reset-relay",
  "main": "src/index.js",
  "compatibility_date": "2026-09-16",
  "kv_namespaces": [{ "binding": "CODEX_RESET_STATE" }],
  "triggers": { "crons": ["*/30 * * * *"] },
  "observability": { "enabled": true }
}
```

`vitest.config.js`:

```js
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["test/**/*.test.js"] },
});
```

`eslint.config.js`:

```js
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", ".wrangler/", "coverage/"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
];
```

`.gitignore`:

```gitignore
node_modules/
.wrangler/
.env
.env.*
.dev.vars
.dev.vars.*
coverage/
.DS_Store
```

`src/index.js`:

```js
export default {
  async fetch() {
    return Response.json({ service: "aihot-codex-reset-relay" });
  },
  async scheduled(_controller, _env, _ctx) {},
};
```

- [ ] **Step 4: Verify scaffold**

```bash
npm test -- test/smoke.test.js
npm run lint
npx wrangler deploy --dry-run
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json wrangler.jsonc vitest.config.js eslint.config.js .gitignore src/index.js test/smoke.test.js
git commit -m "chore: scaffold Cloudflare Worker project"
```

---

### Task 2: Target configuration, hashing, and access-key comparison

**Files:**
- Create: `src/config/targets.js`
- Create: `src/utils/crypto.js`
- Test: `test/config/targets.test.js`
- Test: `test/utils/crypto.test.js`

**Interfaces:**
- Produces `parseTargets(env) -> Promise<{ targets, errors }>`.
- Target shape: `{ id, channel, config }`.
- Produces `sha256Prefix128(value)` and `constantTimeEqual(a, b)`.

- [ ] **Step 1: Write failing config tests**

`test/config/targets.test.js`:

```js
import { describe, expect, it } from "vitest";
import { parseTargets } from "../../src/config/targets.js";

describe("parseTargets", () => {
  it("pairs Telegram token/chat lists exactly", async () => {
    const out = await parseTargets({ TELEGRAM_BOT_TOKEN: "ta;tb", TELEGRAM_CHAT_ID: "1;2" });
    expect(out.errors).toEqual([]);
    expect(out.targets.filter((t) => t.channel === "telegram").map((t) => t.config.chatId)).toEqual(["1", "2"]);
  });

  it("fails Telegram cardinality closed", async () => {
    const out = await parseTargets({ TELEGRAM_BOT_TOKEN: "ta;tb", TELEGRAM_CHAT_ID: "1" });
    expect(out.targets.filter((t) => t.channel === "telegram")).toEqual([]);
    expect(out.errors).toContainEqual({ channel: "telegram", code: "cardinality_mismatch" });
  });

  it("broadcasts one ntfy server/token across topics", async () => {
    const out = await parseTargets({ NTFY_TOPIC: "a;b", NTFY_SERVER_URL: "https://ntfy.example", NTFY_TOKEN: "tk" });
    const ntfy = out.targets.filter((t) => t.channel === "ntfy");
    expect(ntfy.map((t) => [t.config.server, t.config.topic, t.config.token])).toEqual([
      ["https://ntfy.example", "a", "tk"],
      ["https://ntfy.example", "b", "tk"],
    ]);
  });

  it("rejects empty list elements and preserves %3B", async () => {
    const bad = await parseTargets({ SLACK_WEBHOOK_URL: "https://a;;https://b" });
    expect(bad.errors).toContainEqual({ channel: "slack", code: "empty_list_item" });
    const good = await parseTargets({ GENERIC_WEBHOOK_URL: "https://x.test/hook?q=a%3Bb" });
    expect(good.targets[0].config.url).toBe("https://x.test/hook?q=a%3Bb");
  });
});
```

`test/utils/crypto.test.js`:

```js
import { expect, it } from "vitest";
import { constantTimeEqual, sha256Prefix128 } from "../../src/utils/crypto.js";

it("creates 128-bit lowercase hex fingerprints", async () => {
  expect(await sha256Prefix128("abc")).toMatch(/^[0-9a-f]{32}$/);
});

it("compares access keys without early length shortcut", () => {
  expect(constantTimeEqual("secret", "secret")).toBe(true);
  expect(constantTimeEqual("secret", "secrex")).toBe(false);
  expect(constantTimeEqual("secret", "short")).toBe(false);
});
```

- [ ] **Step 2: Implement crypto helpers**

`src/utils/crypto.js`:

```js
export async function sha256Prefix128(value) {
  const data = new TextEncoder().encode(String(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(String(a ?? ""));
  const right = new TextEncoder().encode(String(b ?? ""));
  const max = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < max; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
```

- [ ] **Step 3: Implement deterministic target parsing**

`src/config/targets.js`:

```js
import { sha256Prefix128 } from "../utils/crypto.js";

function splitList(raw) {
  if (raw == null || raw === "") return [];
  const values = String(raw).split(";").map((v) => v.trim());
  if (values.some((v) => v === "")) throw new Error("empty_list_item");
  return values;
}

async function makeTarget(channel, config, identityParts) {
  const hash = await sha256Prefix128([channel, ...identityParts].join("\n"));
  return { id: `${channel}:${hash}`, channel, config };
}

function expand(values, count, fallback) {
  if (values.length === 0) return Array(count).fill(fallback);
  if (values.length === 1) return Array(count).fill(values[0]);
  if (values.length === count) return values;
  throw new Error("cardinality_mismatch");
}

export async function parseTargets(env) {
  const targets = [];
  const errors = [];

  const addWebhook = async (channel, raw, extra = {}) => {
    try {
      for (const url of splitList(raw)) targets.push(await makeTarget(channel, { url, ...extra }, [url]));
    } catch (error) {
      errors.push({ channel, code: error.message });
    }
  };

  await addWebhook("wework", env.WEWORK_WEBHOOK_URL, { msgType: env.WEWORK_MSG_TYPE === "text" ? "text" : "markdown" });
  await addWebhook("feishu", env.FEISHU_WEBHOOK_URL);
  await addWebhook("dingtalk", env.DINGTALK_WEBHOOK_URL);
  await addWebhook("bark", env.BARK_URL);
  await addWebhook("slack", env.SLACK_WEBHOOK_URL);
  await addWebhook("generic-webhook", env.GENERIC_WEBHOOK_URL, { template: env.GENERIC_WEBHOOK_TEMPLATE ?? null });

  try {
    const tokens = splitList(env.TELEGRAM_BOT_TOKEN);
    const chats = splitList(env.TELEGRAM_CHAT_ID);
    if (tokens.length || chats.length) {
      if (tokens.length === 0 || tokens.length !== chats.length) throw new Error("cardinality_mismatch");
      for (let i = 0; i < tokens.length; i += 1) {
        targets.push(await makeTarget("telegram", { token: tokens[i], chatId: chats[i] }, [tokens[i], chats[i]]));
      }
    }
  } catch (error) {
    errors.push({ channel: "telegram", code: error.message });
  }

  try {
    const topics = splitList(env.NTFY_TOPIC);
    if (topics.length) {
      const servers = expand(splitList(env.NTFY_SERVER_URL), topics.length, "https://ntfy.sh");
      const tokens = expand(splitList(env.NTFY_TOKEN), topics.length, null);
      for (let i = 0; i < topics.length; i += 1) {
        const config = { server: servers[i], topic: topics[i], token: tokens[i] };
        targets.push(await makeTarget("ntfy", config, [config.server, config.topic, config.token ?? ""]));
      }
    }
  } catch (error) {
    errors.push({ channel: "ntfy", code: error.message });
  }

  return { targets, errors };
}
```

- [ ] **Step 4: Run tests and commit**

```bash
npm test -- test/config/targets.test.js test/utils/crypto.test.js
npm run lint
git add src/config/targets.js src/utils/crypto.js test/config/targets.test.js test/utils/crypto.test.js
git commit -m "feat: parse notification targets safely"
```

---

### Task 3: AIHOT client, validation, time helpers, and true-latest selection

**Files:**
- Create: `src/utils/time.js`
- Create: `src/aihot/client.js`
- Create: `src/aihot/validate.js`
- Create: `src/aihot/latest.js`
- Create: `test/fixtures/aihot-response.json`
- Test: `test/aihot/client.test.js`
- Test: `test/aihot/validate.test.js`
- Test: `test/aihot/latest.test.js`

**Interfaces:**
- `fetchCodexResets({ etag = null, fetchFn = fetch, nowMs = Date.now() })`.
- `validateSnapshot(snapshot)` throws `SnapshotValidationError` on invalid input.
- `findLatestSourcePost(snapshot) -> { event, post } | null`.
- `parseRetryAfter(value, nowMs)` and `sourceBackoffMs(attemptCount)`.

- [ ] **Step 1: Create regression fixture and failing tests**

`test/fixtures/aihot-response.json`:

```json
{
  "schemaVersion": 1,
  "timezone": "Asia/Shanghai",
  "checkedAt": "2026-09-12T08:10:00Z",
  "historyFrom": "2026-09-01T00:00:00Z",
  "count": 2,
  "events": [
    {
      "id": "updated-later",
      "type": "reset_credit",
      "status": "confirmed",
      "title": "Older post",
      "scope": "all",
      "updatedAt": "2026-09-12T09:00:00Z",
      "confirmationBasis": "source_post",
      "posts": [{ "id": "post-old", "publishedAt": "2026-09-12T07:00:00Z", "text": "old", "url": "https://example.test/old" }],
      "url": "https://aihot.news/codex-reset/old"
    },
    {
      "id": "real-latest",
      "type": "direct_reset",
      "status": "announced",
      "title": "Actual latest",
      "scope": "all",
      "updatedAt": "2026-09-12T08:30:00Z",
      "confirmationBasis": null,
      "posts": [{ "id": "post-latest", "publishedAt": "2026-09-12T08:09:00Z", "text": "latest", "url": "https://example.test/latest" }],
      "url": "https://aihot.news/codex-reset/latest"
    }
  ]
}
```

`test/aihot/latest.test.js`:

```js
import { expect, it } from "vitest";
import fixture from "../fixtures/aihot-response.json" with { type: "json" };
import { findLatestSourcePost } from "../../src/aihot/latest.js";

it("selects by post.publishedAt rather than events[0]", () => {
  expect(findLatestSourcePost(fixture).post.id).toBe("post-latest");
});
```

`test/aihot/validate.test.js`:

```js
import { expect, it } from "vitest";
import fixture from "../fixtures/aihot-response.json" with { type: "json" };
import { validateSnapshot } from "../../src/aihot/validate.js";

it("rejects incompatible schema", () => {
  expect(() => validateSnapshot({ ...fixture, schemaVersion: 2 })).toThrow(/schema_version/);
});

it("rejects conflicting duplicate post ids", () => {
  const bad = structuredClone(fixture);
  bad.events[1].posts.push({ id: "post-old", publishedAt: "2026-09-12T08:08:00Z", text: "conflict", url: "https://example.test/x" });
  expect(() => validateSnapshot(bad)).toThrow(/duplicate_post_conflict/);
});
```

`test/aihot/client.test.js`:

```js
import { expect, it, vi } from "vitest";
import { fetchCodexResets } from "../../src/aihot/client.js";

it("normalizes 304 and sends ETag", async () => {
  const fetchFn = vi.fn(async (_url, init) => {
    expect(init.headers.get("If-None-Match")).toBe('"abc"');
    return new Response(null, { status: 304 });
  });
  await expect(fetchCodexResets({ etag: '"abc"', fetchFn, nowMs: 0 })).resolves.toEqual({ kind: "not_modified" });
});

it("honors 503 Retry-After", async () => {
  const fetchFn = vi.fn(async () => new Response("busy", { status: 503, headers: { "Retry-After": "120" } }));
  const out = await fetchCodexResets({ fetchFn, nowMs: 1_000 });
  expect(out).toMatchObject({ kind: "source_error", status: 503, retryNotBefore: 121_000 });
});
```

Run `npm test -- test/aihot` and expect failures.

- [ ] **Step 2: Implement time helpers**

`src/utils/time.js`:

```js
export function parseIsoMs(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("invalid_timestamp");
  return ms;
}

export function parseRetryAfter(value, nowMs) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return nowMs + Number(trimmed) * 1000;
  const absolute = Date.parse(trimmed);
  return Number.isFinite(absolute) ? absolute : null;
}

export function sourceBackoffMs(attemptCount) {
  return Math.min(5 * 60_000 * 2 ** Math.max(0, attemptCount - 1), 6 * 60 * 60_000);
}
```

- [ ] **Step 3: Implement snapshot validation**

`src/aihot/validate.js`:

```js
import { parseIsoMs } from "../utils/time.js";

export class SnapshotValidationError extends Error {}

export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1) throw new SnapshotValidationError("schema_version");
  if (!Array.isArray(snapshot.events)) throw new SnapshotValidationError("events_shape");
  parseIsoMs(snapshot.checkedAt);
  const seen = new Map();
  for (const event of snapshot.events) {
    if (!Array.isArray(event.posts ?? [])) throw new SnapshotValidationError("posts_shape");
    if (event.updatedAt) parseIsoMs(event.updatedAt);
    if (event.confirmedAt) parseIsoMs(event.confirmedAt);
    for (const post of event.posts ?? []) {
      if (!post?.id) throw new SnapshotValidationError("post_id");
      parseIsoMs(post.publishedAt);
      const fingerprint = JSON.stringify([post.publishedAt, post.text ?? null, post.originalText ?? null, post.url ?? null]);
      const previous = seen.get(String(post.id));
      if (previous && previous !== fingerprint) throw new SnapshotValidationError("duplicate_post_conflict");
      seen.set(String(post.id), fingerprint);
    }
  }
  return snapshot;
}
```

- [ ] **Step 4: Implement true-latest selector and AIHOT client**

`src/aihot/latest.js`:

```js
export function findLatestSourcePost(snapshot) {
  let best = null;
  for (const event of snapshot.events) {
    for (const post of event.posts ?? []) {
      if (!best || post.publishedAt > best.post.publishedAt ||
          (post.publishedAt === best.post.publishedAt && String(post.id) > String(best.post.id))) {
        best = { event, post };
      }
    }
  }
  return best;
}
```

`src/aihot/client.js`:

```js
import { parseRetryAfter } from "../utils/time.js";

const ENDPOINT = "https://aihot.news/api/v1/codex-resets";

export async function fetchCodexResets({ etag = null, fetchFn = fetch, nowMs = Date.now() } = {}) {
  const headers = new Headers({ Accept: "application/json" });
  if (etag) headers.set("If-None-Match", etag);
  try {
    const response = await fetchFn(ENDPOINT, { headers, signal: AbortSignal.timeout(10_000) });
    if (response.status === 304) return { kind: "not_modified" };
    if (response.status === 200) return { kind: "snapshot", snapshot: await response.json(), etag: response.headers.get("ETag") };
    return {
      kind: "source_error",
      status: response.status,
      retryNotBefore: parseRetryAfter(response.headers.get("Retry-After"), nowMs),
      category: `http_${response.status}`,
    };
  } catch (error) {
    return { kind: "source_error", status: null, retryNotBefore: null, category: error?.name === "TimeoutError" ? "timeout" : "network" };
  }
}
```

- [ ] **Step 5: Verify and commit**

```bash
npm test -- test/aihot
npm run lint
git add src/aihot src/utils/time.js test/aihot test/fixtures/aihot-response.json
git commit -m "feat: add AIHOT client and snapshot validation"
```

---

### Task 4: Canonical notifications, boundary watermark, and receipt-review signals

**Files:**
- Create: `src/notification/message.js`
- Create: `src/monitor/signals.js`
- Test: `test/monitor/signals.test.js`

**Interfaces:**
- `buildSourcePostNotification(event, post)`.
- `buildReceiptNotification(event, snapshot)`.
- `detectSignals({ snapshot, meta, existingReceiptSignals, targetIds }) -> { signals, watermark, diagnostics, baselineReceiptSignals }`.

- [ ] **Step 1: Write failing watermark/receipt tests**

`test/monitor/signals.test.js`:

```js
import { expect, it } from "vitest";
import { detectSignals } from "../../src/monitor/signals.js";

const post = (id, publishedAt) => ({ id, publishedAt, text: id, url: `https://example.test/${id}` });
const event = (posts, extra = {}) => ({
  id: "e", type: "direct_reset", status: "announced", title: "Reset", scope: "all",
  updatedAt: "2026-09-16T10:00:00Z", confirmationBasis: null, posts,
  url: "https://aihot.news/e", ...extra,
});

it("uses one immutable W0 for every post in a snapshot", () => {
  const snapshot = { schemaVersion: 1, checkedAt: "2026-09-16T10:30:00Z", events: [event([post("newer", "2026-09-16T10:10:00Z"), post("older-new", "2026-09-16T10:05:00Z")])] };
  const out = detectSignals({ snapshot, meta: { watermark: { publishedAt: "2026-09-16T10:00:00Z", postIdsAtPublishedAt: ["old"] } }, existingReceiptSignals: [], targetIds: ["wework:a"] });
  expect(out.signals.map((s) => s.signalId)).toEqual(["post:older-new", "post:newer"]);
});

it("accepts a new id at the exact boundary timestamp", () => {
  const snapshot = { schemaVersion: 1, checkedAt: "2026-09-16T10:30:00Z", events: [event([post("same-new", "2026-09-16T10:00:00Z")])] };
  const out = detectSignals({ snapshot, meta: { watermark: { publishedAt: "2026-09-16T10:00:00Z", postIdsAtPublishedAt: ["same-old"] } }, existingReceiptSignals: [], targetIds: [] });
  expect(out.signals[0].signalId).toBe("post:same-new");
});

it("anchors receipt review to earliest post and suppresses overlap regrouping", () => {
  const snapshot = { schemaVersion: 1, checkedAt: "2026-09-16T11:00:00Z", events: [event([post("p2", "2026-09-16T09:02:00Z"), post("p1", "2026-09-16T09:01:00Z")], { status: "confirmed", confirmationBasis: "receipt_review" })] };
  const first = detectSignals({ snapshot, meta: { watermark: { publishedAt: "2026-09-16T08:00:00Z", postIdsAtPublishedAt: [] } }, existingReceiptSignals: [], targetIds: [] });
  expect(first.signals.find((s) => s.kind === "receipt_review").signalId).toBe("receipt_review:direct_reset:p1");
  const second = detectSignals({ snapshot, meta: { watermark: first.watermark }, existingReceiptSignals: first.signals.filter((s) => s.kind === "receipt_review"), targetIds: [] });
  expect(second.signals.filter((s) => s.kind === "receipt_review")).toHaveLength(0);
});

it("diagnoses unanchored receipt", () => {
  const snapshot = { schemaVersion: 1, checkedAt: "2026-09-16T11:00:00Z", events: [event([], { status: "confirmed", confirmationBasis: "receipt_review" })] };
  const out = detectSignals({ snapshot, meta: { watermark: { publishedAt: "2026-09-16T08:00:00Z", postIdsAtPublishedAt: [] } }, existingReceiptSignals: [], targetIds: [] });
  expect(out.diagnostics).toContain("unanchored_receipt_review");
});
```

- [ ] **Step 2: Implement canonical builders**

`src/notification/message.js`:

```js
export function buildSourcePostNotification(event, post) {
  return {
    signalId: `post:${post.id}`,
    kind: "source_post",
    title: event.title,
    eventType: event.type,
    eventStatus: event.status,
    scope: event.scope ?? null,
    publishedAt: post.publishedAt,
    scheduleLabel: event.schedule?.label ?? null,
    occurredOn: event.occurredOn ?? null,
    confirmationBasis: event.confirmationBasis ?? null,
    content: post.text ?? post.originalText ?? "",
    sourceUrl: post.url ?? null,
    aihotUrl: event.url ?? null,
  };
}

export function buildReceiptNotification(event, snapshot) {
  return {
    kind: "receipt_review",
    eventType: event.type,
    eventStatus: "confirmed",
    title: event.title,
    scope: event.scope ?? null,
    occurredOn: event.occurredOn ?? null,
    confirmationBasis: "receipt_review",
    observedAt: snapshot.checkedAt,
    content: "AIHOT 已通过 receipt review 确认该 Codex 重置事件。",
    sourceUrl: null,
    aihotUrl: event.url ?? null,
  };
}
```

- [ ] **Step 3: Implement deterministic signal detection**

`src/monitor/signals.js` must implement this control flow exactly:

```js
import { buildReceiptNotification, buildSourcePostNotification } from "../notification/message.js";

const bySignalOrder = (a, b) => a.sortAt.localeCompare(b.sortAt) || a.signalId.localeCompare(b.signalId);

export function detectSignals({ snapshot, meta, existingReceiptSignals, targetIds }) {
  const diagnostics = [];
  const signals = [];
  const baselineReceiptSignals = [];
  const w0 = meta?.watermark ?? null;
  const posts = snapshot.events.flatMap((event) => (event.posts ?? []).map((post) => ({ event, post })));

  for (const { event, post } of posts) {
    if (w0 !== null) {
      const newer = post.publishedAt > w0.publishedAt;
      const sameNewId = post.publishedAt === w0.publishedAt && !w0.postIdsAtPublishedAt.includes(String(post.id));
      if (newer || sameNewId) {
        const notification = buildSourcePostNotification(event, post);
        signals.push({ signalId: notification.signalId, kind: "source_post", discoveredAt: snapshot.checkedAt, sortAt: post.publishedAt, notification, targetIds: [...targetIds] });
      }
    }
  }

  for (const event of snapshot.events) {
    if (event.status !== "confirmed" || event.confirmationBasis !== "receipt_review") continue;
    const validPosts = (event.posts ?? []).filter((p) => p.id && p.publishedAt).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || String(a.id).localeCompare(String(b.id)));
    if (!validPosts.length) { diagnostics.push("unanchored_receipt_review"); continue; }
    const ids = validPosts.map((p) => String(p.id));
    const alreadyKnown = existingReceiptSignals.some((s) => s.eventType === event.type && s.receiptAnchorPostIds?.some((id) => ids.includes(id)));
    if (alreadyKnown) continue;
    const anchorPostId = String(validPosts[0].id);
    const signal = {
      signalId: `receipt_review:${event.type}:${anchorPostId}`,
      kind: "receipt_review",
      eventType: event.type,
      anchorPostId,
      receiptAnchorPostIds: ids,
      discoveredAt: snapshot.checkedAt,
      sortAt: event.confirmedAt ?? event.updatedAt ?? snapshot.checkedAt,
      notification: buildReceiptNotification(event, snapshot),
      targetIds: w0 === null ? [] : [...targetIds],
    };
    if (w0 === null) baselineReceiptSignals.push(signal); else signals.push(signal);
  }

  const maxPublishedAt = posts.reduce((max, { post }) => max === null || post.publishedAt > max ? post.publishedAt : max, w0?.publishedAt ?? null);
  const boundaryIds = maxPublishedAt === null ? [] : posts.filter(({ post }) => post.publishedAt === maxPublishedAt).map(({ post }) => String(post.id)).sort();
  const watermark = maxPublishedAt === null ? w0 : { publishedAt: maxPublishedAt, postIdsAtPublishedAt: boundaryIds };
  signals.sort(bySignalOrder);
  return { signals, watermark, diagnostics, baselineReceiptSignals };
}
```

- [ ] **Step 4: Verify and commit**

```bash
npm test -- test/monitor/signals.test.js
npm run lint
git add src/notification/message.js src/monitor/signals.js test/monitor/signals.test.js
git commit -m "feat: derive reset signals deterministically"
```

---

### Task 5: KV store, physical write discipline, migration, and retention

**Files:**
- Create: `src/state/kv-store.js`
- Test: `test/state/kv-store.test.js`
- Test: `test/state/migration.test.js`

**Interfaces:**
- `createKvStore(kv)` returns the methods listed below.
- `signalKey`, `deliveryKey`, `targetKey` are exported for tests/audits.

- [ ] **Step 1: Write failing physical-key tests**

`test/state/kv-store.test.js`:

```js
import { expect, it } from "vitest";
import { createKvStore } from "../../src/state/kv-store.js";

function fakeKv() {
  const data = new Map();
  const writes = [];
  return {
    data, writes,
    async get(key) { return data.get(key) ?? null; },
    async put(key, value) { writes.push(key); data.set(key, value); },
    async delete(key) { data.delete(key); },
    async list({ prefix = "", cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      return { keys: [...data.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

it("represents pending by absence", async () => {
  const kv = fakeKv();
  const store = createKvStore(kv);
  await store.ensureSignal({ signalId: "post:1", kind: "source_post", targetIds: ["wework:a"] });
  expect(kv.writes).toEqual(["signal:post:1"]);
  expect(await store.getDelivery("post:1", "wework:a")).toBeNull();
});

it("uses separated key families", async () => {
  const kv = fakeKv();
  const store = createKvStore(kv);
  await store.ensureSignal({ signalId: "post:1", kind: "source_post", targetIds: [] });
  await store.putMeta({ stateVersion: 4 });
  await store.putDelivery("post:1", "wework:a", { status: "sent" });
  await store.putDiagnostics({ status: "ok" });
  expect(kv.writes).toEqual(["signal:post:1", "meta:v4", "delivery:post:1:wework:a", "diag:last"]);
});
```

- [ ] **Step 2: Implement complete KV store API**

`src/state/kv-store.js`:

```js
const encode = JSON.stringify;
const decode = (value) => value == null ? null : JSON.parse(value);
export const signalKey = (signalId) => `signal:${signalId}`;
export const deliveryKey = (signalId, targetId) => `delivery:${signalId}:${targetId}`;
export const targetKey = (targetId) => `target:${targetId}`;

async function listAll(kv, prefix) {
  const names = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    names.push(...page.keys.map((k) => k.name));
    if (page.list_complete) break;
    cursor = page.cursor;
  } while (cursor);
  return names;
}

export function createKvStore(kv) {
  return {
    async getMeta() { return decode(await kv.get("meta:v4")); },
    async putMeta(value) { await kv.put("meta:v4", encode(value)); },
    async getSignal(id) { return decode(await kv.get(signalKey(id))); },
    async ensureSignal(signal) {
      const key = signalKey(signal.signalId);
      const existing = decode(await kv.get(key));
      if (existing) return existing;
      try { await kv.put(key, encode(signal)); return signal; }
      catch (error) {
        const converged = decode(await kv.get(key));
        if (converged) return converged;
        throw error;
      }
    },
    async listSignals() { return Promise.all((await listAll(kv, "signal:")).map(async (key) => decode(await kv.get(key)))); },
    async listReceiptSignals() { return (await this.listSignals()).filter((s) => s?.kind === "receipt_review"); },
    async getDelivery(signalId, targetId) { return decode(await kv.get(deliveryKey(signalId, targetId))); },
    async putDelivery(signalId, targetId, value) { await kv.put(deliveryKey(signalId, targetId), encode(value)); },
    async deleteDelivery(signalId, targetId) { await kv.delete(deliveryKey(signalId, targetId)); },
    async getTargetRecord(id) { return decode(await kv.get(targetKey(id))); },
    async putTargetRecord(id, value) { await kv.put(targetKey(id), encode(value)); },
    async listTargetRecords() { return Promise.all((await listAll(kv, "target:")).map(async (key) => decode(await kv.get(key)))); },
    async getSourceBackoff() { return decode(await kv.get("source:backoff")); },
    async putSourceBackoff(value) { await kv.put("source:backoff", encode(value)); },
    async clearSourceBackoff() { await kv.delete("source:backoff"); },
    async getManualLatest() { return decode(await kv.get("manual:latest")); },
    async putManualLatest(value) { await kv.put("manual:latest", encode(value)); },
    async getDiagnostics() { return decode(await kv.get("diag:last")); },
    async putDiagnostics(value) { await kv.put("diag:last", encode(value)); },
    async deleteSignal(id) { await kv.delete(signalKey(id)); },
  };
}
```

Do not add a method that writes a pending delivery record.

- [ ] **Step 3: Add target reconciliation and backlog helpers to the store module**

Append these exports:

```js
export async function reconcileTargets(store, targets, nowIso) {
  const active = new Map(targets.map((t) => [t.id, t]));
  for (const target of targets) {
    const existing = await store.getTargetRecord(target.id);
    if (!existing || existing.status !== "active") {
      await store.putTargetRecord(target.id, { id: target.id, channel: target.channel, status: "active", enabledAt: nowIso, disabledAt: null });
    }
  }
  for (const record of await store.listTargetRecords()) {
    if (record?.status === "active" && !active.has(record.id)) {
      await store.putTargetRecord(record.id, { ...record, status: "disabled", disabledAt: nowIso });
    }
  }
  return active;
}

export async function loadDeliveryWork(store, nowMs) {
  const work = [];
  for (const signal of await store.listSignals()) {
    if (!signal) continue;
    for (const targetId of signal.targetIds ?? []) {
      const delivery = await store.getDelivery(signal.signalId, targetId);
      if (!delivery || (delivery.status === "retry_wait" && delivery.nextAttemptAt <= nowMs)) {
        work.push({ signalId: signal.signalId, sortAt: signal.sortAt, notification: { ...signal.notification, signalId: signal.signalId }, targetId });
      }
    }
  }
  return work;
}
```

- [ ] **Step 4: Write and implement migration/retention tests**

`test/state/migration.test.js` must assert two exact outputs:

```js
expect(await baselineMigrationDiagnostics({ stateVersion: 3, pending: true })).toEqual(["migrated", "legacy_pending_abandoned"]);
expect(await baselineMigrationDiagnostics(null)).toEqual(["migrated"]);
```

Implement:

```js
export async function baselineMigrationDiagnostics(legacyState) {
  const out = ["migrated"];
  if (legacyState?.pending || legacyState?.pendingDeliveries?.length) out.push("legacy_pending_abandoned");
  return out;
}
```

Implement `pruneTerminalSignals(store, nowMs)` with `90 * 24 * 60 * 60_000` retention: skip signals without `discoveredAt`, skip younger signals, and delete a signal only when every target has `sent`, `permanent_failure`, or `disabled`; delete its delivery keys before deleting the signal.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- test/state
npm run lint
git add src/state/kv-store.js test/state
git commit -m "feat: add KV persistence protocol"
```

---

### Task 6: Text safety utilities

**Files:**
- Create: `src/utils/text.js`
- Test: `test/utils/text.test.js`

**Interfaces:**
- `neutralizeMentions`, `escapeHtml`, `escapeMrkdwn`, `escapeMarkdown`, `safeHttpUrl`, `truncateText`.

- [ ] **Step 1: Write failing safety tests**

```js
import { expect, it } from "vitest";
import { escapeHtml, neutralizeMentions, safeHttpUrl, truncateText } from "../../src/utils/text.js";

it("neutralizes mass mentions", () => {
  expect(neutralizeMentions("@everyone @channel @here @all")).toBe("＠everyone ＠channel ＠here ＠all");
});

it("escapes HTML", () => {
  expect(escapeHtml('<b>x & y</b>')).toBe("&lt;b&gt;x &amp; y&lt;/b&gt;");
});

it("filters non-http URLs", () => {
  expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
  expect(safeHttpUrl("https://example.test/x")).toBe("https://example.test/x");
});

it("truncates deterministically", () => {
  expect(truncateText("abcdef", 5)).toBe("abcd…");
});
```

- [ ] **Step 2: Implement utilities**

```js
export const neutralizeMentions = (text) => String(text ?? "").replace(/@(everyone|channel|here|all)\b/gi, "＠$1");
export const escapeHtml = (text) => String(text ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export const escapeMrkdwn = (text) => String(text ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
export const escapeMarkdown = (text) => String(text ?? "").replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
export function safeHttpUrl(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.toString() : null; } catch { return null; }
}
export function truncateText(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
```

- [ ] **Step 3: Verify and commit**

```bash
npm test -- test/utils/text.test.js
npm run lint
git add src/utils/text.js test/utils/text.test.js
git commit -m "feat: sanitize notification content"
```

---

### Task 7: WeCom, Feishu, and DingTalk adapters

**Files:**
- Create: `src/notification/channels/wework.js`
- Create: `src/notification/channels/feishu.js`
- Create: `src/notification/channels/dingtalk.js`
- Test: `test/notification/channels-cn.test.js`

**Interfaces:**
- Every adapter exports `send(target, notification, { fetchFn = fetch } = {})` returning `{ ok, retryable?, code?, retryAfterMs?, error? }`.

- [ ] **Step 1: Write failing adapter tests**

```js
import { expect, it, vi } from "vitest";
import { send as sendWeCom } from "../../src/notification/channels/wework.js";
import { send as sendFeishu } from "../../src/notification/channels/feishu.js";
import { send as sendDingTalk } from "../../src/notification/channels/dingtalk.js";

const note = { title: "Reset", content: "hello @all", publishedAt: "2026-09-16T10:00:00Z", sourceUrl: "https://example.test/post" };

it("WeCom treats business error as failure", async () => {
  const fetchFn = vi.fn(async (_url, init) => {
    expect(JSON.stringify(JSON.parse(init.body))).not.toContain("@all");
    return Response.json({ errcode: 40001, errmsg: "bad" });
  });
  expect((await sendWeCom({ config: { url: "https://wecom.test", msgType: "markdown" } }, note, { fetchFn })).ok).toBe(false);
});

it("Feishu code 0 succeeds", async () => {
  const fetchFn = vi.fn(async () => Response.json({ code: 0, msg: "success" }));
  expect((await sendFeishu({ config: { url: "https://feishu.test" } }, note, { fetchFn })).ok).toBe(true);
});

it("DingTalk nonzero errcode fails", async () => {
  const fetchFn = vi.fn(async () => Response.json({ errcode: 310000, errmsg: "bad" }));
  expect((await sendDingTalk({ config: { url: "https://ding.test" } }, note, { fetchFn })).ok).toBe(false);
});
```

- [ ] **Step 2: Implement a shared local send pattern in each adapter**

Each module should build its own payload but use this exact response classification pattern:

```js
async function postJson(url, body, fetchFn) {
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => null);
    return { response, data };
  } catch (error) {
    return { error, response: null, data: null };
  }
}
```

WeCom payload:

```js
const body = target.config.msgType === "text"
  ? { msgtype: "text", text: { content: renderedText } }
  : { msgtype: "markdown", markdown: { content: renderedMarkdown } };
```

Success: HTTP 2xx and `data.errcode === 0`.

Feishu payload:

```js
{ msg_type: "text", content: { text: renderedText } }
```

Success: HTTP 2xx and (`data.code === 0` or `data.StatusCode === 0`).

DingTalk payload:

```js
{ msgtype: "markdown", markdown: { title: notification.title, text: renderedMarkdown } }
```

Success: HTTP 2xx and `data.errcode === 0`.

For all three: network/timeout, HTTP 408/429/5xx are retryable; typical 400/401/403/404/410 and platform business errors are non-retryable unless the platform response is a documented rate limit. Do not return raw response bodies.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- test/notification/channels-cn.test.js
npm run lint
git add src/notification/channels/wework.js src/notification/channels/feishu.js src/notification/channels/dingtalk.js test/notification/channels-cn.test.js
git commit -m "feat: add WeCom Feishu and DingTalk adapters"
```

---

### Task 8: Telegram, Bark, ntfy, Slack, and Generic Webhook adapters

**Files:**
- Create: `src/notification/channels/telegram.js`
- Create: `src/notification/channels/bark.js`
- Create: `src/notification/channels/ntfy.js`
- Create: `src/notification/channels/slack.js`
- Create: `src/notification/channels/generic-webhook.js`
- Test: `test/notification/channels-global.test.js`

**Interfaces:**
- Same normalized `send()` result contract as Task 7.

- [ ] **Step 1: Write failing adapter tests**

```js
import { expect, it, vi } from "vitest";
import { send as sendTelegram } from "../../src/notification/channels/telegram.js";
import { send as sendNtfy } from "../../src/notification/channels/ntfy.js";
import { send as sendGeneric } from "../../src/notification/channels/generic-webhook.js";

const note = { title: "Reset <now>", content: "hello @everyone", sourceUrl: "https://example.test/post" };

it("Telegram escapes HTML and disables link preview", async () => {
  const fetchFn = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    expect(body.text).toContain("&lt;now&gt;");
    expect(body.link_preview_options).toEqual({ is_disabled: true });
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  expect((await sendTelegram({ config: { token: "t", chatId: "1" } }, note, { fetchFn })).ok).toBe(true);
});

it("ntfy uses topic URL and bearer token", async () => {
  const fetchFn = vi.fn(async (url, init) => {
    expect(url).toBe("https://ntfy.example/topic");
    expect(init.headers.get("Authorization")).toBe("Bearer tk");
    return new Response("ok", { status: 200 });
  });
  expect((await sendNtfy({ config: { server: "https://ntfy.example", topic: "topic", token: "tk" } }, note, { fetchFn })).ok).toBe(true);
});

it("Generic Webhook substitution cannot inject JSON structure", async () => {
  const fetchFn = vi.fn(async (_url, init) => {
    const parsed = JSON.parse(init.body);
    expect(Object.keys(parsed)).toEqual(["message"]);
    return new Response(null, { status: 204 });
  });
  await sendGeneric({ config: { url: "https://hook.test", template: '{"message":"{content}"}' } }, { ...note, content: 'x"},"pwn":true,"x":"' }, { fetchFn });
});
```

- [ ] **Step 2: Implement Telegram, Bark, ntfy, and Slack payloads**

Telegram endpoint/body:

```js
const url = `https://api.telegram.org/bot${target.config.token}/sendMessage`;
const body = {
  chat_id: target.config.chatId,
  text: renderedHtml,
  parse_mode: "HTML",
  link_preview_options: { is_disabled: true },
};
```

Telegram success requires HTTP 2xx and `data.ok === true`.

Bark treats `BARK_URL` as full POST endpoint and sends:

```js
{ title: notification.title, body: renderedText, url: safeHttpUrl(notification.sourceUrl) ?? undefined }
```

HTTP 2xx is transport success; if JSON contains numeric `code`, require `code === 0 || code === 200`.

ntfy sends POST to:

```js
`${target.config.server.replace(/\/$/, "")}/${encodeURIComponent(target.config.topic)}`
```

with plain-text body, `Title` header, optional `Authorization: Bearer <token>`, and 10-second timeout.

Slack Incoming Webhook sends:

```js
{ text: renderedMrkdwn }
```

HTTP 2xx is success. All rendered content passes mention neutralization first.

- [ ] **Step 3: Implement structured Generic Webhook substitution**

Use this exact recursion:

```js
function substitute(value, replacements) {
  if (typeof value === "string") {
    return Object.entries(replacements).reduce((out, [key, replacement]) => out.replaceAll(`{${key}}`, replacement), value);
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, replacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, replacements)]));
  return value;
}
```

Parse `target.config.template` with `JSON.parse()` before substitution. No template means `{ title, content }`. Invalid template returns `{ ok:false, retryable:false, code:"invalid_template" }` without echoing the template.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- test/notification/channels-global.test.js
npm run lint
git add src/notification/channels test/notification/channels-global.test.js
git commit -m "feat: add global notification adapters"
```

---

### Task 9: Retry policy and bounded dispatcher

**Files:**
- Create: `src/notification/retry.js`
- Create: `src/notification/dispatcher.js`
- Test: `test/notification/retry.test.js`
- Test: `test/notification/dispatcher.test.js`

**Interfaces:**
- `deliveryBackoffMs(attemptCount)`.
- `classifyDeliveryFailure(result, attemptCount, nowMs)`.
- `dispatchDeliveries({ work, targetsById, store, adapters, attemptBudget = 10, concurrency = 3, nowMs })`.

- [ ] **Step 1: Write failing retry/dispatcher tests**

`test/notification/retry.test.js`:

```js
import { expect, it } from "vitest";
import { classifyDeliveryFailure, deliveryBackoffMs } from "../../src/notification/retry.js";

it("backs off and makes eighth retry terminal", () => {
  expect(deliveryBackoffMs(1)).toBe(30 * 60_000);
  expect(deliveryBackoffMs(7)).toBe(24 * 60 * 60_000);
  expect(classifyDeliveryFailure({ retryable: true }, 8, 0)).toEqual({ status: "permanent_failure", attemptCount: 8 });
});
```

`test/notification/dispatcher.test.js` should construct explicit work:

```js
const work = [
  { signalId: "post:1", sortAt: "2026-09-16T10:00:00Z", notification: { signalId: "post:1" }, targetId: "A" },
  { signalId: "post:2", sortAt: "2026-09-16T10:01:00Z", notification: { signalId: "post:2" }, targetId: "A" },
  { signalId: "post:1", sortAt: "2026-09-16T10:00:00Z", notification: { signalId: "post:1" }, targetId: "B" },
  { signalId: "post:1", sortAt: "2026-09-16T10:00:00Z", notification: { signalId: "post:1" }, targetId: "C" },
  { signalId: "post:1", sortAt: "2026-09-16T10:00:00Z", notification: { signalId: "post:1" }, targetId: "D" },
];
```

Use targets `{ id, channel:"fake", config:{} }`, a fake store returning no delivery state, and a fake adapter that records active calls. Assert maximum active calls ≤3 and `A:post:1` starts before `A:post:2`. Add explicit tests for visible `sent`, not-yet-due `retry_wait`, removed target → `disabled`, and attemptBudget=10.

- [ ] **Step 2: Implement retry helpers**

`src/notification/retry.js`:

```js
export function deliveryBackoffMs(attemptCount) {
  return Math.min(30 * 60_000 * 2 ** Math.max(0, attemptCount - 1), 24 * 60 * 60_000);
}

export function classifyDeliveryFailure(result, attemptCount, nowMs) {
  if (!result.retryable || attemptCount >= 8) return { status: "permanent_failure", attemptCount };
  const nextAttemptAt = result.retryAfterMs != null ? nowMs + result.retryAfterMs : nowMs + deliveryBackoffMs(attemptCount);
  return { status: "retry_wait", attemptCount, nextAttemptAt };
}
```

- [ ] **Step 3: Implement bounded target-stream dispatcher**

`src/notification/dispatcher.js` core algorithm:

```js
import { classifyDeliveryFailure } from "./retry.js";

export async function dispatchDeliveries({ work, targetsById, store, adapters, attemptBudget = 10, concurrency = 3, nowMs }) {
  const streams = new Map();
  for (const item of work) {
    if (!streams.has(item.targetId)) streams.set(item.targetId, []);
    streams.get(item.targetId).push(item);
  }
  for (const items of streams.values()) items.sort((a, b) => a.sortAt.localeCompare(b.sortAt) || a.signalId.localeCompare(b.signalId));

  const queue = [...streams.entries()];
  let attempts = 0;
  const results = [];

  async function runStream() {
    while (queue.length && attempts < attemptBudget) {
      const [targetId, items] = queue.shift();
      const target = targetsById.get(targetId);
      for (const item of items) {
        if (attempts >= attemptBudget) break;
        const previous = await store.getDelivery(item.signalId, targetId);
        if (previous?.status === "sent" || previous?.status === "permanent_failure" || previous?.status === "disabled") continue;
        if (previous?.status === "retry_wait" && previous.nextAttemptAt > nowMs) continue;
        if (!target) {
          await store.putDelivery(item.signalId, targetId, { status: "disabled", disabledAt: nowMs });
          continue;
        }
        const adapter = adapters[target.channel];
        if (!adapter) {
          await store.putDelivery(item.signalId, targetId, { status: "permanent_failure", attemptCount: (previous?.attemptCount ?? 0) + 1, lastErrorCode: "adapter_missing" });
          continue;
        }
        attempts += 1;
        const result = await adapter.send(target, item.notification);
        if (result.ok) {
          await store.putDelivery(item.signalId, targetId, { status: "sent", sentAt: nowMs, attemptCount: (previous?.attemptCount ?? 0) + 1 });
        } else {
          const attemptCount = (previous?.attemptCount ?? 0) + 1;
          await store.putDelivery(item.signalId, targetId, { ...classifyDeliveryFailure(result, attemptCount, nowMs), lastAttemptAt: nowMs, lastErrorCode: result.code ?? "delivery_failed" });
        }
        results.push({ signalId: item.signalId, targetId, ok: result.ok });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => runStream()));
  return { attempts, results };
}
```

- [ ] **Step 4: Verify and commit**

```bash
npm test -- test/notification/retry.test.js test/notification/dispatcher.test.js
npm run lint
git add src/notification/retry.js src/notification/dispatcher.js test/notification/retry.test.js test/notification/dispatcher.test.js
git commit -m "feat: add bounded notification dispatcher"
```

---

### Task 10: Automatic monitor, migration baseline, source commit, and backlog recovery

**Files:**
- Create: `src/monitor/reset-monitor.js`
- Modify: `src/state/kv-store.js`
- Test: `test/monitor/reset-monitor.test.js`

**Interfaces:**
- `runResetMonitor({ env, nowMs = Date.now(), fetchFn = fetch, adapters, store = createKvStore(env.CODEX_RESET_STATE) }) -> diagnostics`.
- `buildSourceBackoff(previous, sourceResult, nowMs)`.

- [ ] **Step 1: Write deterministic test harness and failing commit-order tests**

At the top of `test/monitor/reset-monitor.test.js`, define:

```js
import { expect, it, vi } from "vitest";
import { runResetMonitor } from "../../src/monitor/reset-monitor.js";

function makeStore(overrides = {}) {
  return {
    getMeta: vi.fn(async () => ({ stateVersion: 4, etag: '"old"', watermark: { publishedAt: "2026-09-16T10:00:00Z", postIdsAtPublishedAt: [] } })),
    putMeta: vi.fn(async () => {}),
    ensureSignal: vi.fn(async (s) => s),
    listReceiptSignals: vi.fn(async () => []),
    listSignals: vi.fn(async () => []),
    getDelivery: vi.fn(async () => null),
    putDelivery: vi.fn(async () => {}),
    getSourceBackoff: vi.fn(async () => null),
    putSourceBackoff: vi.fn(async () => {}),
    clearSourceBackoff: vi.fn(async () => {}),
    getTargetRecord: vi.fn(async () => null),
    putTargetRecord: vi.fn(async () => {}),
    listTargetRecords: vi.fn(async () => []),
    putDiagnostics: vi.fn(async () => {}),
    ...overrides,
  };
}

const snapshot = {
  schemaVersion: 1,
  checkedAt: "2026-09-16T10:30:00Z",
  events: [{ id: "e", type: "direct_reset", status: "announced", title: "Reset", scope: "all", updatedAt: "2026-09-16T10:30:00Z", confirmationBasis: null, posts: [
    { id: "a", publishedAt: "2026-09-16T10:05:00Z", text: "a", url: "https://example.test/a" },
    { id: "b", publishedAt: "2026-09-16T10:10:00Z", text: "b", url: "https://example.test/b" }
  ], url: "https://aihot.news/e" }],
};
```

Test signal writes occur before `putMeta`, and force `ensureSignal` to throw to assert `putMeta` is not called.

- [ ] **Step 2: Add 304/backoff/backlog tests**

Use `makeStore()` with a pending signal returned from `listSignals()`. Mock `fetchFn` to return 304 and an adapter to succeed; assert one delivery attempt occurs. Then set `getSourceBackoff()` to `{ retryNotBefore: 999999 }`, `nowMs:1000`; assert `fetchFn` is not called but backlog delivery still runs.

- [ ] **Step 3: Implement source-backoff builder**

In `src/monitor/reset-monitor.js`:

```js
import { sourceBackoffMs } from "../utils/time.js";

export function buildSourceBackoff(previous, sourceResult, nowMs) {
  const attemptCount = (previous?.attemptCount ?? 0) + 1;
  return {
    attemptCount,
    retryNotBefore: sourceResult.retryNotBefore ?? nowMs + sourceBackoffMs(attemptCount),
    lastStatus: sourceResult.status,
    lastFailureAt: nowMs,
    reason: sourceResult.category,
    updatedAt: nowMs,
  };
}
```

- [ ] **Step 4: Implement monitor control flow**

Use these imports and ordering:

```js
import { fetchCodexResets } from "../aihot/client.js";
import { validateSnapshot } from "../aihot/validate.js";
import { parseTargets } from "../config/targets.js";
import { dispatchDeliveries } from "../notification/dispatcher.js";
import { detectSignals } from "./signals.js";
import { createKvStore, loadDeliveryWork, reconcileTargets } from "../state/kv-store.js";
```

`runResetMonitor()` MUST:

1. parse targets and reconcile `target:*`;
2. read `meta:v4` and source backoff;
3. if no valid V4 meta, fetch a full snapshot with `etag:null`, validate it, call `detectSignals` with no watermark, persist `baselineReceiptSignals` with empty target lists, then commit baseline `meta:v4`; record migration diagnostics and no historical delivery work;
4. otherwise, when source backoff allows, call AIHOT using current ETag;
5. on snapshot: validate, load existing receipt signals, call `detectSignals`, `ensureSignal()` every new signal first, then call `putMeta()` exactly once with ETag/W1/checkedAt;
6. on 304: clear source backoff;
7. on source error: write one source-backoff record and keep old meta;
8. load eligible backlog only after source processing;
9. merge new in-memory signal work with durable backlog by `(signalId,targetId)` dedupe;
10. dispatch budget=10/concurrency=3;
11. write `diag:last` exactly once and return it.

Construct new in-memory work as:

```js
const workForSignal = (signal) => signal.targetIds.map((targetId) => ({
  signalId: signal.signalId,
  sortAt: signal.sortAt,
  notification: { ...signal.notification, signalId: signal.signalId },
  targetId,
}));
```

- [ ] **Step 5: Add overlap and sent-persistence-failure regressions, then commit**

Test two monitor calls sharing a fake KV snapshot where the first `putMeta` succeeds and the second simulates stale W0/reversed meta commit; assert stable `signal:post:a`/`signal:post:b` remain and a third full snapshot converges. Test adapter success followed by `putDelivery` throwing; assert the next run can attempt again, matching at-least-once semantics.

```bash
npm test -- test/monitor/reset-monitor.test.js
npm run lint
git add src/monitor/reset-monitor.js src/state/kv-store.js test/monitor/reset-monitor.test.js
git commit -m "feat: orchestrate Codex reset monitoring"
```

---

### Task 11: Status/health and authenticated mobile `GET /latest`

**Files:**
- Create: `src/routes/status.js`
- Create: `src/routes/latest.js`
- Modify: `src/index.js`
- Test: `test/routes/status.test.js`
- Test: `test/routes/latest.test.js`

**Interfaces:**
- `handleStatus(request, env, deps)`.
- `handleHealth(request, env, deps)`.
- `handleLatest(request, env, { fetchFn = fetch, nowMs = Date.now(), adapters, store = createKvStore(env.CODEX_RESET_STATE) } = {})`.

- [ ] **Step 1: Write failing route-security tests**

```js
import { expect, it, vi } from "vitest";
import { handleLatest } from "../../src/routes/latest.js";

const env = { LATEST_ACCESS_KEY: "secret" };

it("rejects missing key before external requests", async () => {
  const fetchFn = vi.fn();
  const response = await handleLatest(new Request("https://worker.test/latest"), env, { fetchFn, store: fakeStore(), adapters: {} });
  expect(response.status).toBe(403);
  expect(fetchFn).not.toHaveBeenCalled();
});

it("HEAD and prefetch never cause side effects", async () => {
  const fetchFn = vi.fn();
  expect((await handleLatest(new Request("https://worker.test/latest?key=secret", { method: "HEAD" }), env, { fetchFn, store: fakeStore(), adapters: {} })).status).toBe(405);
  expect((await handleLatest(new Request("https://worker.test/latest?key=secret", { headers: { "Sec-Purpose": "prefetch" } }), env, { fetchFn, store: fakeStore(), adapters: {} })).status).toBe(204);
  expect(fetchFn).not.toHaveBeenCalled();
});
```

Define `fakeStore()` in the same test file with `getManualLatest`, `putManualLatest`, `getSourceBackoff`, `putSourceBackoff`, `clearSourceBackoff`, `getDiagnostics`, `listSignals`, and no-op methods required by the route.

- [ ] **Step 2: Add valid-key full-path tests**

Use the Task 3 fixture and a fake adapter target. Assert:

```js
expect(sentNotification.signalId).toBe("post:post-latest");
expect(store.putMeta).not.toHaveBeenCalled();
expect(store.ensureSignal).not.toHaveBeenCalled();
expect(store.putDelivery).not.toHaveBeenCalled();
```

Add cooldown (`lastAcceptedAt` <10s) and active source-backoff tests that assert `fetchFn` is never called. Assert all `/latest` responses carry `Cache-Control:no-store`, `Referrer-Policy:no-referrer`, `X-Robots-Tag:noindex, nofollow`.

- [ ] **Step 3: Implement private response and guard sequence**

`src/routes/latest.js` starts with:

```js
import { fetchCodexResets } from "../aihot/client.js";
import { findLatestSourcePost } from "../aihot/latest.js";
import { validateSnapshot } from "../aihot/validate.js";
import { parseTargets } from "../config/targets.js";
import { constantTimeEqual } from "../utils/crypto.js";
import { buildSourcePostNotification } from "../notification/message.js";
import { createKvStore } from "../state/kv-store.js";

const privateHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};
const privateJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: privateHeaders });
```

Guard order:

```js
const purpose = `${request.headers.get("Sec-Purpose") ?? ""} ${request.headers.get("Purpose") ?? ""}`.toLowerCase();
if (request.method === "HEAD") return new Response(null, { status: 405, headers: { ...privateHeaders, Allow: "GET" } });
if (purpose.includes("prefetch") || purpose.includes("prerender")) return new Response(null, { status: 204, headers: privateHeaders });
if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...privateHeaders, Allow: "GET" } });
const url = new URL(request.url);
if (!constantTimeEqual(url.searchParams.get("key"), env.LATEST_ACCESS_KEY)) return privateJson({ ok: false, reason: "forbidden" }, 403);
```

Then check `manual:latest`; check `source:backoff`; write `manual:latest` immediately before the fresh AIHOT fetch; fetch with `etag:null`; on source error update shared source-backoff operational state; on 200 validate snapshot, find global latest, parse current targets, build source notification, and send to all targets with a dedicated one-notification helper using at most 3 concurrent promises. Do not call automatic `putMeta`, `ensureSignal`, or `putDelivery`.

- [ ] **Step 4: Implement sanitized status/health and Worker routing**

`src/routes/status.js` should parse current targets only for channel counts/errors, read `meta:v4`/`diag:last`, and return fields limited to service/version/source/schedule/check timestamps/channel counts/pending categories. Never serialize target objects or raw errors.

`src/index.js`:

```js
import { handleHealth, handleStatus } from "./routes/status.js";
import { handleLatest } from "./routes/latest.js";
import { runResetMonitor } from "./monitor/reset-monitor.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return handleStatus(request, env);
    if (pathname === "/health") return handleHealth(request, env);
    if (pathname === "/latest") return handleLatest(request, env);
    return Response.json({ ok: false, reason: "not_found" }, { status: 404 });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runResetMonitor({ env }));
  },
};
```

- [ ] **Step 5: Verify and commit**

```bash
npm test -- test/routes
npm run lint
git add src/routes src/index.js test/routes
git commit -m "feat: add status health and latest routes"
```

---

### Task 12: Worker-runtime integration tests

**Files:**
- Create: `test/integration/worker.test.js`

**Interfaces:**
- Uses `env` from `cloudflare:workers` and local simulated KV from `@cloudflare/vitest-plugin`.

- [ ] **Step 1: Write a real-KV separation test**

```js
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { createKvStore } from "../../src/state/kv-store.js";

beforeEach(async () => {
  let cursor;
  do {
    const page = await env.CODEX_RESET_STATE.list({ cursor });
    await Promise.all(page.keys.map((k) => env.CODEX_RESET_STATE.delete(k.name)));
    if (page.list_complete) break;
    cursor = page.cursor;
  } while (cursor);
});

it("stores signal and delivery on separate physical keys", async () => {
  const store = createKvStore(env.CODEX_RESET_STATE);
  await store.ensureSignal({ signalId: "post:1", kind: "source_post", targetIds: ["wework:a"] });
  expect(await env.CODEX_RESET_STATE.get("delivery:post:1:wework:a")).toBeNull();
  await store.putDelivery("post:1", "wework:a", { status: "sent" });
  expect(await env.CODEX_RESET_STATE.get("signal:post:1")).not.toBeNull();
  expect(await env.CODEX_RESET_STATE.get("delivery:post:1:wework:a")).not.toBeNull();
  expect(await env.CODEX_RESET_STATE.get("state:v4")).toBeNull();
});
```

- [ ] **Step 2: Add status secret-leak test**

Invoke the exported Worker on `/` with test-only env values and assert response text does not contain webhook URL, Telegram token, `LATEST_ACCESS_KEY`, or target hash. Populate `diag:last` with sanitized data first.

- [ ] **Step 3: Add automatic-state isolation test for `/latest`**

Import `handleLatest` directly with injected `fetchFn`, fake adapters, and real `createKvStore(env.CODEX_RESET_STATE)`. Seed `meta:v4`, invoke a valid-key request, and assert the exact original `meta:v4` remains byte-for-byte unchanged and no new `signal:*`/`delivery:*` keys appear.

- [ ] **Step 4: Run integration/full suite and commit**

```bash
npm test
npm run lint
git add test/integration/worker.test.js
git commit -m "test: cover Worker runtime and KV integration"
```

---

### Task 13: CI, license, and bilingual deployment documentation

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `LICENSE`
- Create: `README.md`
- Create: `README_EN.md`

**Interfaces:**
- Produces user-facing deploy/operator contract matching the approved spec.

- [ ] **Step 1: Add CI**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run lint
```

No Cloudflare token and no deploy step.

- [ ] **Step 2: Add MIT license**

Use standard MIT License text with year `2026` and copyright holder `LewLIu`.

- [ ] **Step 3: Write `README.md` with exact operator workflow**

Include these commands:

```bash
npm install
npx wrangler login
npx wrangler secret put LATEST_ACCESS_KEY
npx wrangler deploy
```

Then list every channel secret name and exact semicolon/cardinality rules. Explain Wrangler KV automatic provisioning from the binding-only `wrangler.jsonc`. Document Cron, source backoff, delivery retry, concurrency=3, budget=10, at-least-once duplicate windows, V3→V4 baseline migration, and AIHOT licensing/attribution boundary.

For a mobile bookmark, show the concrete shape without inventing a deployment hostname:

```text
https://YOUR_WORKER_SUBDOMAIN.workers.dev/latest?key=YOUR_256_BIT_RANDOM_KEY
```

Explicitly state that the complete bookmarked URL is a secret capability and must be rotated if exposed.

- [ ] **Step 4: Write `README_EN.md` with the same normative constraints**

Keep exact environment-variable names, Cron schedule, concurrency/budget numbers, migration behavior, security model, and AIHOT attribution/licensing boundary.

- [ ] **Step 5: Verify and commit**

```bash
npm test
npm run lint
npx wrangler deploy --dry-run
git add .github/workflows/ci.yml LICENSE README.md README_EN.md
git commit -m "docs: add deployment guide license and CI"
```

---

### Task 14: Final verification against the approved spec

**Files:**
- Modify only files implicated by a failing verification check.

**Interfaces:**
- Produces a deployable V1 with evidence for all spec invariants.

- [ ] **Step 1: Run complete verification**

```bash
npm ci
npm test
npm run lint
npx wrangler deploy --dry-run
```

Expected: all pass.

- [ ] **Step 2: Run critical regressions individually**

```bash
npm test -- test/aihot/latest.test.js
npm test -- test/monitor/signals.test.js
npm test -- test/state/kv-store.test.js
npm test -- test/monitor/reset-monitor.test.js
npm test -- test/notification/dispatcher.test.js
npm test -- test/routes/latest.test.js
npm test -- test/integration/worker.test.js
```

Expected: all pass.

- [ ] **Step 3: Audit KV physical writes**

```bash
grep -R "state:v4\|pending:index\|sleep(1000)" -n src test || true
grep -R "CODEX_RESET_STATE.put" -n src test || true
```

Expected: no monolithic `state:v4`, no `pending:index`, no sleep workaround. Any direct KV writes must map to approved key families: `meta:v4`, `signal:*`, `delivery:*`, `target:*`, `source:backoff`, `manual:latest`, `diag:last`.

- [ ] **Step 4: Audit secrets**

```bash
grep -R "LATEST_ACCESS_KEY\|WEBHOOK_URL\|BOT_TOKEN\|NTFY_TOKEN" -n . --exclude-dir=node_modules --exclude=package-lock.json
```

Expected: only code/docs/config-name references; no real credentials. Confirm `.env*` and `.dev.vars*` are ignored.

- [ ] **Step 5: Commit only real fixes**

If verification changed files:

```bash
git add -A
git commit -m "fix: close final relay verification gaps"
```

If verification is clean, do not create an empty commit.

---

## Self-Review Checklist

- **Spec coverage:** AIHOT semantics, KV physical contract, receipt anchoring, boundary watermark, commit ordering, target lifecycle/cardinality, retries/backoff, bounded concurrency, all eight adapters, untrusted rendering, `/latest`, migration, retention, diagnostics, CI/docs/security all map to explicit tasks.
- **Placeholder scan:** no `TBD`, `TODO`, “similar to Task N”, undefined test harness names, or “implement later” instructions remain.
- **Type/name consistency:** `parseTargets`, `fetchCodexResets`, `validateSnapshot`, `findLatestSourcePost`, `detectSignals`, `createKvStore`, `reconcileTargets`, `loadDeliveryWork`, `dispatchDeliveries`, `runResetMonitor`, `handleStatus`, `handleHealth`, and `handleLatest` are stable across tasks.
- **Current Cloudflare stack:** Wrangler 4 + Vitest 4.1+ + `@cloudflare/vitest-plugin`, not the legacy `@cloudflare/vitest-pool-workers` integration.
- **TDD:** every implementation task starts with a failing test, then minimal implementation, verification, and a focused commit.
