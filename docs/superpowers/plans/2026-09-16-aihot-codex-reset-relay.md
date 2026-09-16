# AIHOT Codex Reset Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted Cloudflare Worker that safely monitors AIHOT Codex Reset snapshots, persists immutable signals/per-target delivery state in Workers KV, retries failures, supports eight notification adapters, and exposes authenticated one-tap `GET /latest` testing.

**Architecture:** ES-module JavaScript on Cloudflare Workers. Pure domain modules validate AIHOT snapshots and derive deterministic signals; Workers KV stores separated `meta`, `signal`, `delivery`, `target`, backoff, manual-cooldown, and diagnostic keys. Notification adapters share one canonical notification model, while a bounded dispatcher enforces three concurrent target streams and per-target serial ordering.

**Tech Stack:** JavaScript ES modules, Cloudflare Workers + Workers KV, Wrangler 4, Vitest 4.1+ with `@cloudflare/vitest-plugin`, ESLint 9, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-16-aihot-reset-relay-design.md`

## Global Constraints

- AIHOT endpoint: `https://aihot.news/api/v1/codex-resets`.
- Cron: `*/30 * * * *`.
- Workers KV binding: `CODEX_RESET_STATE`.
- Expected AIHOT `schemaVersion`: `1`.
- Source-post signal ID: `post:<post.id>`.
- Receipt signal ID: `receipt_review:<event.type>:<anchorPostId>` with overlap dedupe.
- Boundary watermark: `{ publishedAt, postIdsAtPublishedAt[] }`; one immutable W0 per snapshot.
- Signal records are immutable; missing `delivery:<signalId>:<targetId>` means pending.
- Never collapse state into one hot KV key and never add sleeps to work around same-key write limits.
- Delivery is at-least-once; crash/stale-KV duplicate windows are accepted and documented.
- Delivery retry: 30m → 1h → 2h → 4h → 8h → 16h → 24h → 24h; eighth failed retryable attempt becomes `permanent_failure`.
- Source backoff without `Retry-After`: 5m → 10m → 20m → 40m → 80m → 160m → 320m → 6h.
- Maximum 10 automatic notification attempts per Cron invocation.
- Maximum 3 concurrent target streams; signals for one target are serial by `(sortAt, signalId)`.
- Outbound request timeout: 10 seconds.
- `/latest` remains `GET`, always requires `LATEST_ACCESS_KEY`, and must check HEAD/prefetch guards, auth, cooldown, and source backoff before AIHOT.
- `/latest` never mutates automatic signal/delivery/ETag/watermark state.
- AIHOT text/URLs are untrusted input; adapters escape markup, neutralize mass mentions, filter URLs, and validate platform business success.
- V3→V4 is baseline migration; unreconstructable legacy pending intent is abandoned with `legacy_pending_abandoned` diagnostics.
- No Durable Objects, email delivery, admin UI, SaaS, or automatic Cloudflare deployment in V1.

---

## File Map

```text
.github/workflows/ci.yml                 # test/lint CI only
src/index.js                             # Worker fetch + scheduled entrypoints
src/config/targets.js                    # env parsing, multi-target expansion, config diagnostics
src/aihot/client.js                      # conditional fetch, timeout, Retry-After parsing
src/aihot/validate.js                    # schema/snapshot invariants
src/aihot/latest.js                      # global newest source-post selection
src/monitor/signals.js                   # watermark/source-post/receipt signal derivation
src/monitor/reset-monitor.js             # Cron orchestration + source commit protocol
src/state/kv-store.js                    # physical KV key contract, listing, migration, retention
src/notification/message.js              # canonical notification builders
src/notification/retry.js                # retry classification/backoff
src/notification/dispatcher.js           # per-target streams, concurrency=3, budget=10
src/notification/channels/wework.js      # WeCom adapter
src/notification/channels/feishu.js      # Feishu adapter
src/notification/channels/dingtalk.js    # DingTalk adapter
src/notification/channels/telegram.js    # Telegram adapter
src/notification/channels/bark.js        # Bark adapter
src/notification/channels/ntfy.js        # ntfy adapter
src/notification/channels/slack.js       # Slack adapter
src/notification/channels/generic-webhook.js # generic JSON webhook adapter
src/routes/status.js                     # GET / and GET /health
src/routes/latest.js                     # authenticated GET /latest
src/utils/crypto.js                      # SHA-256 128-bit target fingerprints + constant-time key compare
src/utils/text.js                        # escaping, mention neutralization, URL filtering, truncation
src/utils/time.js                        # ISO parsing, Retry-After, backoff helpers
test/fixtures/aihot-response.json        # regression fixture reproducing events[0] ordering bug
test/**/*.test.js                        # unit/integration tests
vitest.config.js                         # @cloudflare/vitest-plugin config
eslint.config.js                         # ESLint flat config
wrangler.jsonc                           # Worker, KV auto-provision binding, Cron trigger
package.json                             # scripts/dependencies
.gitignore                               # secret/build/local-state exclusions
README.md / README_EN.md / LICENSE       # user docs + MIT license
```

---

### Task 1: Scaffold the Worker, test runtime, linting, and configuration

**Files:**
- Create: `package.json`
- Create: `wrangler.jsonc`
- Create: `vitest.config.js`
- Create: `eslint.config.js`
- Create: `.gitignore`
- Create: `src/index.js`
- Create: `test/smoke.test.js`

**Interfaces:**
- Produces: Cloudflare Worker ES-module entrypoint exporting `fetch(request, env, ctx)` and `scheduled(controller, env, ctx)`.
- Produces: runtime binding `env.CODEX_RESET_STATE`.

- [ ] **Step 1: Initialize package metadata and install current supported tooling**

Run:

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

Expected: `package.json` is ES-module based and `npm test`/`npm run lint` scripts exist.

- [ ] **Step 2: Write the failing smoke test**

Create `test/smoke.test.js`:

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

Run:

```bash
npm test -- test/smoke.test.js
```

Expected: FAIL because `src/index.js` does not exist.

- [ ] **Step 3: Add Wrangler/Vitest/ESLint configuration and minimal entrypoint**

Create `wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "aihot-codex-reset-relay",
  "main": "src/index.js",
  "compatibility_date": "2026-09-16",
  "kv_namespaces": [
    { "binding": "CODEX_RESET_STATE" }
  ],
  "triggers": {
    "crons": ["*/30 * * * *"]
  },
  "observability": {
    "enabled": true
  }
}
```

Create `vitest.config.js`:

```js
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["test/**/*.test.js"] },
});
```

Create `eslint.config.js`:

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
      globals: { ...globals.worker, ...globals.node },
    },
    rules: { "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }] },
  },
];
```

Create `.gitignore`:

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

Create `src/index.js`:

```js
export default {
  async fetch() {
    return new Response(JSON.stringify({ service: "aihot-codex-reset-relay" }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
  async scheduled(_controller, _env, _ctx) {},
};
```

- [ ] **Step 4: Verify scaffold is green**

Run:

```bash
npm test -- test/smoke.test.js
npm run lint
npx wrangler deploy --dry-run
```

Expected: all commands PASS; dry-run recognizes `CODEX_RESET_STATE` and Cron config.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json wrangler.jsonc vitest.config.js eslint.config.js .gitignore src/index.js test/smoke.test.js
git commit -m "chore: scaffold Cloudflare Worker project"
```

---

### Task 2: Implement target configuration parsing and target fingerprints

**Files:**
- Create: `src/config/targets.js`
- Create: `src/utils/crypto.js`
- Test: `test/config/targets.test.js`

**Interfaces:**
- Produces: `parseTargets(env) -> Promise<{ targets: Target[], errors: ConfigError[] }>`.
- Produces: `target.id` in `<channel>:<32 lowercase hex>` form.
- Produces: `constantTimeEqual(a, b) -> boolean` for `/latest` key verification.

- [ ] **Step 1: Write failing multi-target/cardinality tests**

Create `test/config/targets.test.js`:

```js
import { describe, expect, it } from "vitest";
import { parseTargets } from "../../src/config/targets.js";

describe("parseTargets", () => {
  it("pairs Telegram lists by index", async () => {
    const result = await parseTargets({
      TELEGRAM_BOT_TOKEN: "tok-a;tok-b",
      TELEGRAM_CHAT_ID: "100;200",
    });
    expect(result.errors).toEqual([]);
    expect(result.targets.map((t) => [t.channel, t.config.chatId])).toEqual([
      ["telegram", "100"],
      ["telegram", "200"],
    ]);
  });

  it("fails Telegram cardinality closed", async () => {
    const result = await parseTargets({
      TELEGRAM_BOT_TOKEN: "tok-a;tok-b",
      TELEGRAM_CHAT_ID: "100",
    });
    expect(result.targets.filter((t) => t.channel === "telegram")).toEqual([]);
    expect(result.errors).toEqual([{ channel: "telegram", code: "cardinality_mismatch" }]);
  });

  it("broadcasts one ntfy server/token across N topics", async () => {
    const result = await parseTargets({
      NTFY_TOPIC: "alpha;beta",
      NTFY_SERVER_URL: "https://ntfy.example",
      NTFY_TOKEN: "secret",
    });
    expect(result.targets.filter((t) => t.channel === "ntfy").map((t) => t.config.topic)).toEqual(["alpha", "beta"]);
  });

  it("rejects empty semicolon entries and keeps encoded %3B inside values", async () => {
    const bad = await parseTargets({ SLACK_WEBHOOK_URL: "https://a;;https://b" });
    expect(bad.errors[0].code).toBe("empty_list_item");

    const good = await parseTargets({ GENERIC_WEBHOOK_URL: "https://x.test/hook?a=x%3By" });
    expect(good.targets[0].config.url).toBe("https://x.test/hook?a=x%3By");
  });
});
```

Run:

```bash
npm test -- test/config/targets.test.js
```

Expected: FAIL because module does not exist.

- [ ] **Step 2: Implement SHA-256 fingerprinting and constant-time string comparison**

Create `src/utils/crypto.js`:

```js
export async function sha256Prefix128(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
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

- [ ] **Step 3: Implement deterministic target expansion**

Create `src/config/targets.js` with these exported helpers and rules:

```js
import { sha256Prefix128 } from "../utils/crypto.js";

function splitList(raw) {
  if (raw == null || raw === "") return [];
  const parts = raw.split(";").map((v) => v.trim());
  if (parts.some((v) => v === "")) throw new Error("empty_list_item");
  return parts;
}

async function makeTarget(channel, config, identity) {
  const hash = await sha256Prefix128(`${channel}\n${identity}`);
  return { id: `${channel}:${hash}`, channel, config };
}

export async function parseTargets(env) {
  const targets = [];
  const errors = [];

  const addWebhookList = async (channel, raw, extra = {}) => {
    try {
      for (const url of splitList(raw)) targets.push(await makeTarget(channel, { url, ...extra }, url));
    } catch (error) {
      errors.push({ channel, code: error.message });
    }
  };

  await addWebhookList("wework", env.WEWORK_WEBHOOK_URL, { msgType: env.WEWORK_MSG_TYPE === "text" ? "text" : "markdown" });
  await addWebhookList("feishu", env.FEISHU_WEBHOOK_URL);
  await addWebhookList("dingtalk", env.DINGTALK_WEBHOOK_URL);
  await addWebhookList("bark", env.BARK_URL);
  await addWebhookList("slack", env.SLACK_WEBHOOK_URL);
  await addWebhookList("generic-webhook", env.GENERIC_WEBHOOK_URL, { template: env.GENERIC_WEBHOOK_TEMPLATE ?? null });

  try {
    const tokens = splitList(env.TELEGRAM_BOT_TOKEN);
    const chats = splitList(env.TELEGRAM_CHAT_ID);
    if (tokens.length || chats.length) {
      if (!tokens.length || tokens.length !== chats.length) throw new Error("cardinality_mismatch");
      for (let i = 0; i < tokens.length; i += 1) {
        targets.push(await makeTarget("telegram", { token: tokens[i], chatId: chats[i] }, `${tokens[i]}\n${chats[i]}`));
      }
    }
  } catch (error) {
    errors.push({ channel: "telegram", code: error.message });
  }

  try {
    const topics = splitList(env.NTFY_TOPIC);
    if (topics.length) {
      const servers = splitList(env.NTFY_SERVER_URL);
      const tokens = splitList(env.NTFY_TOKEN);
      const expand = (values, fallback) => values.length === 0 ? Array(topics.length).fill(fallback) : values.length === 1 ? Array(topics.length).fill(values[0]) : values.length === topics.length ? values : null;
      const expandedServers = expand(servers, "https://ntfy.sh");
      const expandedTokens = expand(tokens, null);
      if (!expandedServers || !expandedTokens) throw new Error("cardinality_mismatch");
      for (let i = 0; i < topics.length; i += 1) {
        const config = { server: expandedServers[i], topic: topics[i], token: expandedTokens[i] };
        targets.push(await makeTarget("ntfy", config, `${config.server}\n${config.topic}`));
      }
    }
  } catch (error) {
    errors.push({ channel: "ntfy", code: error.message });
  }

  return { targets, errors };
}
```

- [ ] **Step 4: Run tests and lint**

```bash
npm test -- test/config/targets.test.js
npm run lint
```

Expected: PASS; diagnostics contain no raw secrets.

- [ ] **Step 5: Commit**

```bash
git add src/config/targets.js src/utils/crypto.js test/config/targets.test.js
git commit -m "feat: parse notification targets safely"
```

---

### Task 3: Implement AIHOT fetch, validation, latest-post selection, and source backoff helpers

**Files:**
- Create: `src/aihot/client.js`
- Create: `src/aihot/validate.js`
- Create: `src/aihot/latest.js`
- Create: `src/utils/time.js`
- Create: `test/fixtures/aihot-response.json`
- Test: `test/aihot/client.test.js`
- Test: `test/aihot/validate.test.js`
- Test: `test/aihot/latest.test.js`

**Interfaces:**
- Produces: `fetchCodexResets({ etag, fetchFn, nowMs })` normalized result.
- Produces: `validateSnapshot(snapshot)` returning validated snapshot or throwing `SnapshotValidationError`.
- Produces: `findLatestSourcePost(snapshot) -> { event, post } | null`.
- Produces: `parseRetryAfter(value, nowMs)` and `sourceBackoffMs(attemptCount)`.

- [ ] **Step 1: Create the regression fixture and failing latest-post test**

Create `test/fixtures/aihot-response.json`:

```json
{
  "schemaVersion": 1,
  "timezone": "Asia/Shanghai",
  "checkedAt": "2026-09-12T08:10:00Z",
  "historyFrom": "2026-09-01T00:00:00Z",
  "count": 2,
  "events": [
    {
      "id": "event-updated-later",
      "type": "reset_credit",
      "status": "confirmed",
      "title": "Older source post but newer event update",
      "scope": "all",
      "updatedAt": "2026-09-12T09:00:00Z",
      "confirmationBasis": "source_post",
      "posts": [{ "id": "post-old", "publishedAt": "2026-09-12T07:00:00Z", "text": "old", "url": "https://example.test/old" }],
      "url": "https://aihot.news/codex-reset/old"
    },
    {
      "id": "event-real-latest",
      "type": "direct_reset",
      "status": "announced",
      "title": "Actual newest source post",
      "scope": "all",
      "updatedAt": "2026-09-12T08:30:00Z",
      "confirmationBasis": null,
      "posts": [{ "id": "post-latest", "publishedAt": "2026-09-12T08:09:00Z", "text": "latest", "url": "https://example.test/latest" }],
      "url": "https://aihot.news/codex-reset/latest"
    }
  ]
}
```

Create `test/aihot/latest.test.js`:

```js
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/aihot-response.json" with { type: "json" };
import { findLatestSourcePost } from "../../src/aihot/latest.js";

it("selects global latest by post.publishedAt, not events[0]", () => {
  const latest = findLatestSourcePost(fixture);
  expect(latest.post.id).toBe("post-latest");
  expect(latest.event.id).toBe("event-real-latest");
});
```

Run: `npm test -- test/aihot/latest.test.js`.
Expected: FAIL.

- [ ] **Step 2: Add validation tests**

Create `test/aihot/validate.test.js`:

```js
import { expect, it } from "vitest";
import fixture from "../fixtures/aihot-response.json" with { type: "json" };
import { validateSnapshot } from "../../src/aihot/validate.js";

it("accepts schemaVersion 1", () => {
  expect(validateSnapshot(structuredClone(fixture)).schemaVersion).toBe(1);
});

it("rejects incompatible schema", () => {
  expect(() => validateSnapshot({ ...fixture, schemaVersion: 2 })).toThrow(/schema_version/);
});

it("rejects conflicting duplicate post ids", () => {
  const bad = structuredClone(fixture);
  bad.events[1].posts.push({ id: "post-old", publishedAt: "2026-09-12T08:08:00Z", text: "conflict", url: "https://example.test/x" });
  expect(() => validateSnapshot(bad)).toThrow(/duplicate_post_conflict/);
});
```

- [ ] **Step 3: Add conditional-fetch and Retry-After tests**

Create `test/aihot/client.test.js`:

```js
import { describe, expect, it, vi } from "vitest";
import { fetchCodexResets } from "../../src/aihot/client.js";

it("sends If-None-Match and normalizes 304", async () => {
  const fetchFn = vi.fn(async (_url, init) => {
    expect(init.headers.get("If-None-Match")).toBe('"abc"');
    return new Response(null, { status: 304 });
  });
  await expect(fetchCodexResets({ etag: '"abc"', fetchFn, nowMs: 0 })).resolves.toEqual({ kind: "not_modified" });
});

it("returns retryNotBefore for 503 Retry-After", async () => {
  const fetchFn = vi.fn(async () => new Response("busy", { status: 503, headers: { "Retry-After": "120" } }));
  const result = await fetchCodexResets({ etag: null, fetchFn, nowMs: 1_000 });
  expect(result.kind).toBe("source_error");
  expect(result.status).toBe(503);
  expect(result.retryNotBefore).toBe(121_000);
});
```

- [ ] **Step 4: Implement time helpers, validator, latest selector, and client**

Use these exact contracts:

```js
// src/utils/time.js
export function parseIsoMs(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("invalid_timestamp");
  return ms;
}

export function parseRetryAfter(value, nowMs) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return nowMs + Number(value.trim()) * 1000;
  const absolute = Date.parse(value);
  return Number.isFinite(absolute) ? absolute : null;
}

export function sourceBackoffMs(attemptCount) {
  return Math.min(5 * 60_000 * 2 ** Math.max(0, attemptCount - 1), 6 * 60 * 60_000);
}
```

```js
// src/aihot/latest.js
export function findLatestSourcePost(snapshot) {
  let best = null;
  for (const event of snapshot.events) {
    for (const post of event.posts ?? []) {
      if (!best || Date.parse(post.publishedAt) > Date.parse(best.post.publishedAt) ||
          (post.publishedAt === best.post.publishedAt && String(post.id) > String(best.post.id))) {
        best = { event, post };
      }
    }
  }
  return best;
}
```

`src/aihot/validate.js` MUST validate schema version, arrays, valid ordering timestamps, and conflicting duplicate IDs before returning the snapshot.

`src/aihot/client.js` MUST use `AbortSignal.timeout(10_000)`, set `Accept: application/json`, conditionally set `If-None-Match`, normalize `200`/`304`, and return `retryNotBefore` for any error response carrying valid `Retry-After`.

- [ ] **Step 5: Run AIHOT tests and commit**

```bash
npm test -- test/aihot
npm run lint
git add src/aihot src/utils/time.js test/aihot test/fixtures/aihot-response.json
git commit -m "feat: add AIHOT client and snapshot validation"
```

---

### Task 4: Implement canonical notifications, watermark classification, and receipt-review detection

**Files:**
- Create: `src/notification/message.js`
- Create: `src/monitor/signals.js`
- Test: `test/monitor/signals.test.js`

**Interfaces:**
- Produces: `buildSourcePostNotification(event, post)`.
- Produces: `buildReceiptNotification(event, snapshot)`.
- Produces: `detectSignals({ snapshot, meta, existingReceiptSignals, targetIds }) -> { signals, watermark, diagnostics }`.

- [ ] **Step 1: Write failing batch-watermark tests**

Create `test/monitor/signals.test.js` with:

```js
import { describe, expect, it } from "vitest";
import { detectSignals } from "../../src/monitor/signals.js";

function post(id, publishedAt) {
  return { id, publishedAt, text: id, url: `https://example.test/${id}` };
}
function event(posts, extra = {}) {
  return { id: "e", type: "direct_reset", status: "announced", title: "Reset", scope: "all", updatedAt: "2026-09-16T10:00:00Z", confirmationBasis: null, posts, url: "https://aihot.news/e", ...extra };
}

it("classifies every post against immutable W0", () => {
  const snapshot = { schemaVersion: 1, checkedAt: "2026-09-16T10:30:00Z", events: [event([post("newer", "2026-09-16T10:10:00Z"), post("older-new", "2026-09-16T10:05:00Z")])] };
  const result = detectSignals({ snapshot, meta: { watermark: { publishedAt: "2026-09-16T10:00:00Z", postIdsAtPublishedAt: ["old"] } }, existingReceiptSignals: [], targetIds: ["wework:a"] });
  expect(result.signals.map((s) => s.signalId)).toEqual(["post:older-new", "post:newer"]);
});

it("discovers a different post id at the exact boundary timestamp", () => {
  const snapshot = { schemaVersion: 1, checkedAt: "2026-09-16T10:30:00Z", events: [event([post("same-new", "2026-09-16T10:00:00Z")])] };
  const result = detectSignals({ snapshot, meta: { watermark: { publishedAt: "2026-09-16T10:00:00Z", postIdsAtPublishedAt: ["same-old"] } }, existingReceiptSignals: [], targetIds: [] });
  expect(result.signals[0].signalId).toBe("post:same-new");
});
```

- [ ] **Step 2: Add receipt-review anchor/overlap tests**

Add:

```js
it("anchors receipt review to earliest source post", () => {
  const snapshot = { schemaVersion: 1, checkedAt: "2026-09-16T11:00:00Z", events: [event([post("p2", "2026-09-16T09:02:00Z"), post("p1", "2026-09-16T09:01:00Z")], { status: "confirmed", confirmationBasis: "receipt_review", occurredOn: "2026-09-16" })] };
  const result = detectSignals({ snapshot, meta: { watermark: null }, existingReceiptSignals: [], targetIds: [] });
  expect(result.signals.find((s) => s.kind === "receipt_review").signalId).toBe("receipt_review:direct_reset:p1");
});

it("suppresses regrouped receipt when source-post sets overlap", () => {
  const snapshot = { schemaVersion: 1, checkedAt: "2026-09-16T11:00:00Z", events: [event([post("p0", "2026-09-16T08:00:00Z"), post("p1", "2026-09-16T09:01:00Z")], { status: "confirmed", confirmationBasis: "receipt_review" })] };
  const existingReceiptSignals = [{ signalId: "receipt_review:direct_reset:p1", kind: "receipt_review", receiptAnchorPostIds: ["p1", "p2"] }];
  const result = detectSignals({ snapshot, meta: { watermark: null }, existingReceiptSignals, targetIds: [] });
  expect(result.signals.filter((s) => s.kind === "receipt_review")).toHaveLength(0);
});

it("diagnoses unanchored receipt instead of inventing an id", () => {
  const snapshot = { schemaVersion: 1, checkedAt: "2026-09-16T11:00:00Z", events: [event([], { status: "confirmed", confirmationBasis: "receipt_review" })] };
  const result = detectSignals({ snapshot, meta: { watermark: null }, existingReceiptSignals: [], targetIds: [] });
  expect(result.diagnostics).toContain("unanchored_receipt_review");
});
```

- [ ] **Step 3: Implement deterministic builders and detector**

`buildSourcePostNotification(event, post)` must copy plain fields and use `schedule.label` as `scheduleLabel` without relabeling it as actual reset time.

`buildReceiptNotification(event, snapshot)` must return:

```js
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
  aihotUrl: event.url,
};
```

`detectSignals()` MUST bootstrap with no historical notifications when `meta.watermark == null`, classify every post against entry W0, then compute W1 only after traversal. Signal `discoveredAt` should use `snapshot.checkedAt` for deterministic overlapping processing.

- [ ] **Step 4: Run tests and commit**

```bash
npm test -- test/monitor/signals.test.js
npm run lint
git add src/notification/message.js src/monitor/signals.js test/monitor/signals.test.js
git commit -m "feat: derive reset signals deterministically"
```

---

### Task 5: Implement KV store, physical write contract, migration, and retention

**Files:**
- Create: `src/state/kv-store.js`
- Test: `test/state/kv-store.test.js`
- Test: `test/state/migration.test.js`

**Interfaces:**
- Produces key helpers: `signalKey`, `deliveryKey`, `targetKey`.
- Produces store methods: `getMeta`, `putMeta`, `ensureSignal`, `listSignals`, `getDelivery`, `putDelivery`, `get/putTargetRecord`, `get/putSourceBackoff`, `get/putManualLatest`, `putDiagnostics`, `listReceiptSignals`, `migrateToV4`, `pruneTerminalSignals`.

- [ ] **Step 1: Write failing key/write-discipline tests**

Create `test/state/kv-store.test.js` using a recording fake KV:

```js
import { expect, it } from "vitest";
import { createKvStore } from "../../src/state/kv-store.js";

function fakeKv() {
  const data = new Map();
  const writes = [];
  return {
    writes,
    async get(key) { return data.get(key) ?? null; },
    async put(key, value) { writes.push(key); data.set(key, value); },
    async delete(key) { data.delete(key); },
    async list({ prefix = "", cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      return { keys: [...data.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

it("does not write a pending delivery record", async () => {
  const kv = fakeKv();
  const store = createKvStore(kv);
  await store.ensureSignal({ signalId: "post:1", kind: "source_post", targetIds: ["wework:a"] });
  expect(kv.writes).toEqual(["signal:post:1"]);
  expect(await store.getDelivery("post:1", "wework:a")).toBeNull();
});

it("keeps signal, delivery, meta and diagnostics on separate keys", async () => {
  const kv = fakeKv();
  const store = createKvStore(kv);
  await store.ensureSignal({ signalId: "post:1", kind: "source_post", targetIds: [] });
  await store.putMeta({ stateVersion: 4 });
  await store.putDelivery("post:1", "wework:a", { status: "sent" });
  await store.putDiagnostics({ status: "ok" });
  expect(kv.writes).toEqual(["signal:post:1", "meta:v4", "delivery:post:1:wework:a", "diag:last"]);
});
```

- [ ] **Step 2: Implement separated KV access**

Core helpers:

```js
const json = (value) => JSON.stringify(value);
const parse = (value) => value == null ? null : JSON.parse(value);

export const signalKey = (signalId) => `signal:${signalId}`;
export const deliveryKey = (signalId, targetId) => `delivery:${signalId}:${targetId}`;
export const targetKey = (targetId) => `target:${targetId}`;

export function createKvStore(kv) {
  return {
    async getMeta() { return parse(await kv.get("meta:v4")); },
    async putMeta(meta) { await kv.put("meta:v4", json(meta)); },
    async getSignal(signalId) { return parse(await kv.get(signalKey(signalId))); },
    async ensureSignal(signal) {
      const key = signalKey(signal.signalId);
      const existing = parse(await kv.get(key));
      if (existing) return existing;
      await kv.put(key, json(signal));
      return signal;
    },
    async getDelivery(signalId, targetId) { return parse(await kv.get(deliveryKey(signalId, targetId))); },
    async putDelivery(signalId, targetId, value) { await kv.put(deliveryKey(signalId, targetId), json(value)); },
    async putDiagnostics(value) { await kv.put("diag:last", json(value)); },
    async getSourceBackoff() { return parse(await kv.get("source:backoff")); },
    async putSourceBackoff(value) { await kv.put("source:backoff", json(value)); },
    async getManualLatest() { return parse(await kv.get("manual:latest")); },
    async putManualLatest(value) { await kv.put("manual:latest", json(value)); },
    // add paginated listSignals/listReceiptSignals and target lifecycle methods here with the same separated-key rule
  };
}
```

For `ensureSignal`, if `put()` fails because an overlapping writer won, re-read once; if the stable signal now exists, treat it as converged, otherwise rethrow so the caller does not advance `meta:v4`.

- [ ] **Step 3: Write migration tests**

Create `test/state/migration.test.js` asserting:

```js
it("baselines V4 without replaying historical signals", async () => {
  const result = await store.migrateToV4({ legacyState: { stateVersion: 3, seenPostIds: ["old"] }, snapshot, targets: [] });
  expect(result.createdDeliveryWork).toBe(0);
  expect(result.diagnostics).toContain("migrated");
});

it("abandons unreconstructable legacy pending intent explicitly", async () => {
  const result = await store.migrateToV4({ legacyState: { stateVersion: 3, pending: true }, snapshot, targets: [] });
  expect(result.diagnostics).toContain("legacy_pending_abandoned");
});
```

- [ ] **Step 4: Implement paginated listing, migration and 90-day pruning**

`listSignals()` and `listReceiptSignals()` must loop until `list_complete === true`. `pruneTerminalSignals({ nowMs })` deletes only signals older than 90 days whose every target is `sent`, `permanent_failure`, or `disabled`, then deletes their delivery keys.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- test/state
npm run lint
git add src/state/kv-store.js test/state
git commit -m "feat: add KV persistence protocol"
```

---

### Task 6: Implement safe text rendering utilities

**Files:**
- Create: `src/utils/text.js`
- Test: `test/utils/text.test.js`

**Interfaces:**
- Produces: `neutralizeMentions`, `escapeHtml`, `escapeMrkdwn`, `safeHttpUrl`, `truncateText`.

- [ ] **Step 1: Write failing safety tests**

```js
import { expect, it } from "vitest";
import { escapeHtml, neutralizeMentions, safeHttpUrl, truncateText } from "../../src/utils/text.js";

it("neutralizes mass mentions", () => {
  expect(neutralizeMentions("@everyone @channel @here @all")).toBe("＠everyone ＠channel ＠here ＠all");
});

it("escapes Telegram HTML", () => {
  expect(escapeHtml('<b>x & y</b>')).toBe("&lt;b&gt;x &amp; y&lt;/b&gt;");
});

it("allows only http/https URLs", () => {
  expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
  expect(safeHttpUrl("https://example.test/x")).toBe("https://example.test/x");
});

it("truncates with an ellipsis", () => {
  expect(truncateText("abcdef", 5)).toBe("abcd…");
});
```

- [ ] **Step 2: Implement utilities**

```js
export const neutralizeMentions = (text) => String(text ?? "").replace(/@(everyone|channel|here|all)\b/gi, "＠$1");
export const escapeHtml = (text) => String(text ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export const escapeMrkdwn = (text) => String(text ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
export function safeHttpUrl(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.toString() : null; } catch { return null; }
}
export function truncateText(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
```

- [ ] **Step 3: Run tests and commit**

```bash
npm test -- test/utils/text.test.js
npm run lint
git add src/utils/text.js test/utils/text.test.js
git commit -m "feat: sanitize notification content"
```

---

### Task 7: Implement WeCom, Feishu, and DingTalk adapters

**Files:**
- Create: `src/notification/channels/wework.js`
- Create: `src/notification/channels/feishu.js`
- Create: `src/notification/channels/dingtalk.js`
- Test: `test/notification/channels-cn.test.js`

**Interfaces:**
- Each module exports `send(target, notification, { fetchFn = fetch } = {}) -> Promise<{ ok, code?, error? }>`.
- Inputs are canonical plain notifications and parsed target configs.

- [ ] **Step 1: Write failing payload/business-error tests**

```js
import { expect, it, vi } from "vitest";
import { send as sendWeCom } from "../../src/notification/channels/wework.js";
import { send as sendFeishu } from "../../src/notification/channels/feishu.js";
import { send as sendDingTalk } from "../../src/notification/channels/dingtalk.js";

const note = { title: "Reset", content: "hello @all", publishedAt: "2026-09-16T10:00:00Z", sourceUrl: "https://example.test/post" };

it("WeCom validates errcode even on HTTP 200", async () => {
  const fetchFn = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    expect(body.msgtype).toBe("markdown");
    expect(JSON.stringify(body)).not.toContain("@all");
    return Response.json({ errcode: 40001, errmsg: "bad" });
  });
  await expect(sendWeCom({ config: { url: "https://wecom.test", msgType: "markdown" } }, note, { fetchFn })).resolves.toMatchObject({ ok: false });
});

it("Feishu code 0 is success", async () => {
  const fetchFn = vi.fn(async () => Response.json({ code: 0, msg: "success" }));
  await expect(sendFeishu({ config: { url: "https://feishu.test" } }, note, { fetchFn })).resolves.toMatchObject({ ok: true });
});

it("DingTalk nonzero errcode is failure", async () => {
  const fetchFn = vi.fn(async () => Response.json({ errcode: 310000, errmsg: "keywords not in content" }));
  await expect(sendDingTalk({ config: { url: "https://ding.test" } }, note, { fetchFn })).resolves.toMatchObject({ ok: false });
});
```

- [ ] **Step 2: Implement WeCom**

Use POST JSON. Markdown payload:

```js
{
  msgtype: "markdown",
  markdown: { content: renderedText }
}
```

Plain text payload when `msgType === "text"`:

```js
{
  msgtype: "text",
  text: { content: renderedText }
}
```

Success requires HTTP 2xx **and** `errcode === 0`.

- [ ] **Step 3: Implement Feishu and DingTalk**

Feishu text payload:

```js
{ msg_type: "text", content: { text: renderedText } }
```

Treat response as success when HTTP is 2xx and either `code === 0` or legacy-compatible `StatusCode === 0`; otherwise normalize failure.

DingTalk Markdown payload:

```js
{ msgtype: "markdown", markdown: { title: note.title, text: renderedText } }
```

Success requires HTTP 2xx and `errcode === 0`.

All three use `AbortSignal.timeout(10_000)`, neutralize mass mentions, filter unsafe URLs, and never include raw exception bodies in returned errors.

- [ ] **Step 4: Run tests and commit**

```bash
npm test -- test/notification/channels-cn.test.js
npm run lint
git add src/notification/channels/wework.js src/notification/channels/feishu.js src/notification/channels/dingtalk.js test/notification/channels-cn.test.js
git commit -m "feat: add WeCom Feishu and DingTalk adapters"
```

---

### Task 8: Implement Telegram, Bark, ntfy, Slack, and Generic Webhook adapters

**Files:**
- Create: `src/notification/channels/telegram.js`
- Create: `src/notification/channels/bark.js`
- Create: `src/notification/channels/ntfy.js`
- Create: `src/notification/channels/slack.js`
- Create: `src/notification/channels/generic-webhook.js`
- Test: `test/notification/channels-global.test.js`

**Interfaces:**
- Same normalized `send(target, notification, { fetchFn })` contract as Task 7.

- [ ] **Step 1: Write failing adapter tests**

```js
import { expect, it, vi } from "vitest";
import { send as sendTelegram } from "../../src/notification/channels/telegram.js";
import { send as sendNtfy } from "../../src/notification/channels/ntfy.js";
import { send as sendGeneric } from "../../src/notification/channels/generic-webhook.js";

const note = { title: "Reset <now>", content: "hello @everyone", sourceUrl: "https://example.test/post" };

it("Telegram escapes HTML and disables link previews", async () => {
  const fetchFn = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    expect(body.parse_mode).toBe("HTML");
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
  await sendNtfy({ config: { server: "https://ntfy.example", topic: "topic", token: "tk" } }, note, { fetchFn });
});

it("generic template substitution cannot break JSON structure", async () => {
  const fetchFn = vi.fn(async (_url, init) => {
    expect(() => JSON.parse(init.body)).not.toThrow();
    return new Response(null, { status: 204 });
  });
  await sendGeneric({ config: { url: "https://hook.test", template: '{"message":"{content}"}' } }, { ...note, content: 'x"},"pwn":true,"x":"' }, { fetchFn });
});
```

- [ ] **Step 2: Implement Telegram**

POST to:

```js
`https://api.telegram.org/bot${target.config.token}/sendMessage`
```

Body:

```js
{
  chat_id: target.config.chatId,
  text: renderedHtml,
  parse_mode: "HTML",
  link_preview_options: { is_disabled: true }
}
```

Success requires HTTP 2xx and `{ ok: true }`.

- [ ] **Step 3: Implement Bark, ntfy, and Slack**

Bark treats configured `BARK_URL` as the full POST endpoint and sends:

```js
{ title: note.title, body: renderedText, url: safeHttpUrl(note.sourceUrl) ?? undefined }
```

Treat HTTP 2xx as transport success; if JSON body contains `code`, require `code === 200` or `code === 0`.

ntfy POSTs plain rendered content to `${server-without-trailing-slash}/${encodeURIComponent(topic)}` with `Title` header and optional `Authorization: Bearer <token>`.

Slack Incoming Webhook POSTs:

```js
{ text: renderedMrkdwn }
```

HTTP 2xx is success; never forward upstream mass mentions unchanged.

- [ ] **Step 4: Implement structured Generic Webhook substitution**

Parse `GENERIC_WEBHOOK_TEMPLATE` as JSON first. Recursively replace `{title}` and `{content}` **inside string values**, then `JSON.stringify()` the resulting object. With no template, send:

```js
{ title: note.title, content: renderedText }
```

Invalid template is a non-retryable adapter configuration error and must not expose the template contents.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- test/notification/channels-global.test.js
npm run lint
git add src/notification/channels test/notification/channels-global.test.js
git commit -m "feat: add global notification adapters"
```

---

### Task 9: Implement retry classification, target lifecycle, and bounded dispatcher

**Files:**
- Create: `src/notification/retry.js`
- Create: `src/notification/dispatcher.js`
- Test: `test/notification/retry.test.js`
- Test: `test/notification/dispatcher.test.js`

**Interfaces:**
- Produces: `classifyDeliveryResult(result, attemptCount, nowMs)`.
- Produces: `dispatchDeliveries({ work, targetsById, store, attemptBudget = 10, concurrency = 3, nowMs })`.
- Consumes adapter map keyed by channel.

- [ ] **Step 1: Write retry policy tests**

```js
import { expect, it } from "vitest";
import { deliveryBackoffMs, classifyDeliveryFailure } from "../../src/notification/retry.js";

it("uses 30m exponential delivery backoff capped at 24h", () => {
  expect(deliveryBackoffMs(1)).toBe(30 * 60_000);
  expect(deliveryBackoffMs(7)).toBe(24 * 60 * 60_000);
});

it("makes the eighth failed retryable attempt permanent", () => {
  expect(classifyDeliveryFailure({ retryable: true }, 8, 0)).toEqual({ status: "permanent_failure", attemptCount: 8 });
});
```

- [ ] **Step 2: Write dispatcher concurrency/order tests**

Use a fake adapter that records active streams:

```js
it("never exceeds three target streams and serializes one target", async () => {
  const starts = [];
  let active = 0;
  let maxActive = 0;
  const send = async (target, note) => {
    active += 1; maxActive = Math.max(maxActive, active); starts.push(`${target.id}:${note.signalId}`);
    await Promise.resolve();
    active -= 1;
    return { ok: true };
  };
  // work contains two signals for target A and one each for B/C/D
  await dispatchDeliveries({ work, targetsById, store, adapters: { fake: { send } }, attemptBudget: 10, concurrency: 3, nowMs: 0 });
  expect(maxActive).toBeLessThanOrEqual(3);
  expect(starts.indexOf("A:post:1")).toBeLessThan(starts.indexOf("A:post:2"));
});
```

Also test: visible `sent` is skipped; removed target becomes `disabled`; retry_wait before `nextAttemptAt` is skipped; budget stops after 10 attempts.

- [ ] **Step 3: Implement retry helpers**

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

- [ ] **Step 4: Implement per-target-stream dispatcher**

Build `Map<targetId, work[]>`, sort each stream by `(sortAt, signalId)`, and run at most three stream workers. Each stream checks delivery state before send, attempts serially, persists only that pair's outcome, and stops when global attempt budget reaches 10. Never use unbounded `Promise.allSettled(work)`.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- test/notification/retry.test.js test/notification/dispatcher.test.js
npm run lint
git add src/notification/retry.js src/notification/dispatcher.js test/notification/retry.test.js test/notification/dispatcher.test.js
git commit -m "feat: add bounded notification dispatcher"
```

---

### Task 10: Implement automatic reset monitor and source commit protocol

**Files:**
- Create: `src/monitor/reset-monitor.js`
- Test: `test/monitor/reset-monitor.test.js`

**Interfaces:**
- Produces: `runResetMonitor({ env, nowMs, fetchFn }) -> diagnostics`.
- Consumes Tasks 2–5 and 9.

- [ ] **Step 1: Write failing commit-order tests**

```js
it("persists every new signal before committing meta", async () => {
  const calls = [];
  const store = fakeStore({
    ensureSignal: async (s) => calls.push(`signal:${s.signalId}`),
    putMeta: async () => calls.push("meta"),
  });
  await runResetMonitor(harness({ store, snapshotWithTwoNewPosts }));
  expect(calls.indexOf("meta")).toBeGreaterThan(calls.indexOf("signal:post:a"));
  expect(calls.indexOf("meta")).toBeGreaterThan(calls.indexOf("signal:post:b"));
});

it("does not advance meta when required signal persistence fails", async () => {
  const store = fakeStore({ ensureSignal: async () => { throw new Error("kv_write_failed"); } });
  await expect(runResetMonitor(harness({ store }))).rejects.toThrow(/kv_write_failed/);
  expect(store.putMeta).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Add 304/backlog and source-backoff tests**

```js
it("processes durable retry backlog on AIHOT 304", async () => {
  const result = await runResetMonitor(harness({ sourceResult: { kind: "not_modified" }, backlog: [pendingWork] }));
  expect(result.deliveryAttempts).toBe(1);
});

it("skips AIHOT while source backoff is active but still processes backlog", async () => {
  const h = harness({ sourceBackoff: { retryNotBefore: 999_999 }, nowMs: 1_000, backlog: [pendingWork] });
  await runResetMonitor(h);
  expect(h.fetchFn).not.toHaveBeenCalled();
  expect(h.adapter.send).toHaveBeenCalled();
});
```

- [ ] **Step 3: Implement orchestration**

`runResetMonitor` order MUST be:

```js
// conceptual order, preserve exactly
const { targets, errors } = await parseTargets(env);
await reconcileTargets(store, targets);
const sourceBackoff = await store.getSourceBackoff();
let newSignals = [];
if (!sourceBackoff || sourceBackoff.retryNotBefore <= nowMs) {
  const source = await fetchCodexResets({ etag: meta?.etag ?? null, fetchFn, nowMs });
  // 200: validate → detect against immutable W0 → ensure every signal → putMeta once
  // 304: clear/reset source failure state
  // source error: persist source backoff, never advance meta
}
const work = [...newSignals, ...(await loadEligibleBacklog(store, nowMs))];
await dispatchDeliveries({ work, targetsById, store, attemptBudget: 10, concurrency: 3, nowMs });
await store.putDiagnostics(sanitizedDiagnostics);
```

Ensure source polling occurs before delivery backlog and `diag:last` is written once.

- [ ] **Step 4: Add overlap/persistence-failure regression**

Simulate two executions beginning from the same W0 and one `putMeta` failing/reversing order. Assert stable signal records survive and a later full snapshot converges. Also simulate external send success followed by `putDelivery(sent)` failure; next run may resend, documenting at-least-once behavior.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- test/monitor/reset-monitor.test.js
npm run lint
git add src/monitor/reset-monitor.js test/monitor/reset-monitor.test.js
git commit -m "feat: orchestrate Codex reset monitoring"
```

---

### Task 11: Implement public status/health routes and authenticated `GET /latest`

**Files:**
- Create: `src/routes/status.js`
- Create: `src/routes/latest.js`
- Modify: `src/index.js`
- Test: `test/routes/status.test.js`
- Test: `test/routes/latest.test.js`

**Interfaces:**
- Produces: `handleStatus(request, env)` and `handleHealth(request, env)`.
- Produces: `handleLatest(request, env, { fetchFn = fetch, nowMs = Date.now() } = {})`.

- [ ] **Step 1: Write failing route-security tests**

```js
it("rejects missing latest key before any external request", async () => {
  const fetchFn = vi.fn();
  const response = await handleLatest(new Request("https://worker.test/latest"), env, { fetchFn, nowMs: 0 });
  expect(response.status).toBe(403);
  expect(fetchFn).not.toHaveBeenCalled();
});

it("HEAD and prefetch never cause side effects", async () => {
  const fetchFn = vi.fn();
  expect((await handleLatest(new Request("https://worker.test/latest?key=k", { method: "HEAD" }), env, { fetchFn })).status).toBe(405);
  expect((await handleLatest(new Request("https://worker.test/latest?key=k", { headers: { "Sec-Purpose": "prefetch" } }), env, { fetchFn })).status).toBe(204);
  expect(fetchFn).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Add fresh-AIHOT/latest-selection/state-isolation tests**

Test a valid key where AIHOT fixture's `events[0]` is not global latest. Assert the adapter receives `post-latest`; assert `putMeta`, `ensureSignal`, and automatic `putDelivery` are never called. Add 10-second cooldown and active source-backoff tests that assert AIHOT is not fetched.

- [ ] **Step 3: Implement `/latest` guard sequence exactly**

```js
export async function handleLatest(request, env, deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const nowMs = deps.nowMs ?? Date.now();
  const purpose = `${request.headers.get("Sec-Purpose") ?? ""} ${request.headers.get("Purpose") ?? ""}`.toLowerCase();
  if (request.method === "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  if (purpose.includes("prefetch") || purpose.includes("prerender")) return new Response(null, { status: 204 });
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });

  const url = new URL(request.url);
  if (!constantTimeEqual(url.searchParams.get("key"), env.LATEST_ACCESS_KEY)) return privateJson({ ok: false, reason: "forbidden" }, 403);

  // then manual cooldown → source backoff → fresh AIHOT fetch → validate → global latest → parse targets → bounded send
}
```

`privateJson()` MUST add `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow` to every `/latest` response.

- [ ] **Step 4: Implement status/health and route dispatch**

`GET /` returns sanitized service/source/schedule/last-check/target-count/pending counts only. `GET /health` returns minimal sanitized health. Unknown paths return 404. `src/index.js` routes `/`, `/health`, `/latest` and calls `runResetMonitor()` from `scheduled()` via `ctx.waitUntil()`.

- [ ] **Step 5: Run route tests and commit**

```bash
npm test -- test/routes
npm run lint
git add src/routes src/index.js test/routes
git commit -m "feat: add status health and latest routes"
```

---

### Task 12: Add Worker-runtime integration tests with real local KV binding

**Files:**
- Create: `test/integration/worker.test.js`

**Interfaces:**
- Uses Cloudflare Vitest runtime `env` and Worker handler.
- Verifies local KV behavior through `env.CODEX_RESET_STATE`.

- [ ] **Step 1: Write integration test for KV-separated state**

```js
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import worker from "../../src/index.js";

beforeEach(async () => {
  const listed = await env.CODEX_RESET_STATE.list();
  await Promise.all(listed.keys.map((k) => env.CODEX_RESET_STATE.delete(k.name)));
});

it("status route never exposes stored secret-like values", async () => {
  await env.CODEX_RESET_STATE.put("diag:last", JSON.stringify({ status: "ok" }));
  const response = await worker.fetch(new Request("https://worker.test/"), env, {});
  const body = await response.text();
  expect(body).not.toContain("webhook");
  expect(body).not.toContain("token");
});
```

- [ ] **Step 2: Add integration test for pending-by-absence**

Persist one `signal:*` directly, assert its `delivery:*` key is absent, invoke monitor with mocked adapter/source, then assert only the per-target delivery key appears—not a monolithic `state:v4` key.

- [ ] **Step 3: Add integration test for `/latest` headers and no automatic-state mutation**

Invoke `worker.fetch()` with test secret, mocked outbound source/adapter injection exposed through a test-only dependency factory or direct route import. Assert privacy headers and unchanged `meta:v4`/`signal:*` keys.

- [ ] **Step 4: Run full suite**

```bash
npm test
npm run lint
```

Expected: all unit and Worker-runtime integration tests PASS.

- [ ] **Step 5: Commit**

```bash
git add test/integration
git commit -m "test: cover Worker runtime and KV integration"
```

---

### Task 13: Add README docs, MIT license, and CI

**Files:**
- Create: `README.md`
- Create: `README_EN.md`
- Create: `LICENSE`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces deploy/operator documentation matching the approved spec.

- [ ] **Step 1: Add CI first and verify it runs only quality checks**

Create `.github/workflows/ci.yml`:

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

Create `LICENSE` with the standard MIT text, copyright year `2026`, copyright holder `LewLIu`.

- [ ] **Step 3: Write Chinese README with exact deploy/security workflow**

README MUST include these concrete commands:

```bash
npm install
npx wrangler login
npx wrangler secret put LATEST_ACCESS_KEY
npx wrangler secret put WEWORK_WEBHOOK_URL   # only if WeCom is used
npx wrangler deploy
```

Explain that `wrangler.jsonc` uses KV automatic provisioning; first deploy creates/writes the namespace binding if not already provisioned. Document all channel variables, semicolon/cardinality rules, Cron, source backoff, delivery retry, migration, at-least-once duplicate windows, and AIHOT usage boundary.

Include mobile test example:

```text
https://<your-worker>.workers.dev/latest?key=<your-random-256-bit-key>
```

State explicitly that the complete bookmark URL is a secret capability and must be rotated if disclosed.

- [ ] **Step 4: Write English README with the same normative content**

Do not translate away constraints: keep exact env names, 30-minute Cron, concurrency=3, attempt budget=10, migration behavior, and AIHOT attribution/licensing boundary.

- [ ] **Step 5: Run local quality checks and commit**

```bash
npm test
npm run lint
npx wrangler deploy --dry-run
git add README.md README_EN.md LICENSE .github/workflows/ci.yml
git commit -m "docs: add deployment guide license and CI"
```

---

### Task 14: Final verification against the approved spec

**Files:**
- Modify only files required by failures found in this verification.

**Interfaces:**
- Produces: implementation ready for deployment, with evidence that all approved design invariants are covered.

- [ ] **Step 1: Run all automated checks**

```bash
npm ci
npm test
npm run lint
npx wrangler deploy --dry-run
```

Expected: all PASS.

- [ ] **Step 2: Run targeted regression tests individually**

```bash
npm test -- test/aihot/latest.test.js
npm test -- test/monitor/signals.test.js
npm test -- test/state/kv-store.test.js
npm test -- test/monitor/reset-monitor.test.js
npm test -- test/notification/dispatcher.test.js
npm test -- test/routes/latest.test.js
npm test -- test/integration/worker.test.js
```

Expected: all PASS.

- [ ] **Step 3: Audit the physical KV contract**

Search:

```bash
grep -R "state:v4\|pending:index\|sleep(1000)" -n src test || true
```

Expected: no implementation of a monolithic `state:v4`, no hot `pending:index`, and no sleep workaround.

Also inspect all `CODEX_RESET_STATE.put`/store writes and confirm they map only to the approved key families: `meta:v4`, `signal:*`, `delivery:*`, `target:*`, `source:backoff`, `manual:latest`, `diag:last`.

- [ ] **Step 4: Audit secret handling**

```bash
grep -R "LATEST_ACCESS_KEY\|WEBHOOK_URL\|BOT_TOKEN\|NTFY_TOKEN" -n . --exclude-dir=node_modules --exclude=package-lock.json
```

Expected: only source/docs/config-name references; no real credential values. Confirm `.env*` and `.dev.vars*` are ignored.

- [ ] **Step 5: Commit any verification-only fixes, otherwise record the clean result**

If fixes were required:

```bash
git add -A
git commit -m "fix: close final relay verification gaps"
```

If no fixes were required, do not create an empty commit.

---

## Self-Review Checklist

Before execution begins, the plan author verified:

- **Spec coverage:** every approved section is represented: AIHOT semantics, key-level KV contract, receipt anchoring, boundary watermark, commit order, target lifecycle/config cardinality, retry/backoff, bounded concurrency, eight adapters, untrusted rendering, `/latest`, migration, retention, diagnostics, CI/docs/security.
- **Physical KV coverage:** tests explicitly assert missing delivery key = pending, separated key families, signal-before-meta ordering, persistence-failure behavior, and overlapping-execution convergence.
- **No placeholder scan:** no `TBD`, `TODO`, “similar to Task N”, or unresolved function/type names remain.
- **Interface consistency:** `parseTargets`, `fetchCodexResets`, `validateSnapshot`, `findLatestSourcePost`, `detectSignals`, `createKvStore`, `dispatchDeliveries`, `runResetMonitor`, and route handlers have one stable naming contract across tasks.
- **Current Cloudflare testing stack:** plan uses Wrangler 4 and the current `@cloudflare/vitest-plugin` with Vitest 4.1+ rather than the older `@cloudflare/vitest-pool-workers` integration.
