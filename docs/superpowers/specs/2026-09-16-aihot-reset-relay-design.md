# AIHOT Codex Reset Relay — Design Specification

Date: 2026-09-16
Status: Draft — pending user review
Repository: `LewLIu/aihot-codex-reset-relay`

## 1. Purpose

AIHOT Codex Reset Relay is a self-hosted Cloudflare Workers project that monitors AIHOT's public Codex Reset API and relays new Codex reset information to user-configured notification channels.

The project does **not** collect posts from X/Twitter, independently determine whether a Codex reset happened, mirror AIHOT's API, or provide a hosted SaaS service. AIHOT is the upstream source of structured Codex Reset data; this project is responsible for polling, validation, state tracking, deduplication, retryable delivery, and channel-specific notification formatting.

Primary data flow:

```text
Tibo / upstream sources
        ↓
      AIHOT
        ↓
AIHOT Codex Reset API
        ↓
aihot-codex-reset-relay
        ↓
WeCom / Feishu / DingTalk / Telegram / Bark / ntfy / Slack / Generic Webhook
```

## 2. Scope and product constraints

### In scope

- Monitor `https://aihot.news/api/v1/codex-resets`.
- Poll every 30 minutes using a Cloudflare Cron Trigger.
- Use ETag / `If-None-Match` conditional requests.
- Respect AIHOT rate limiting, including `429` and `Retry-After`.
- Detect new source posts using `posts[].id`.
- Use `posts[].publishedAt` as the source-post chronology boundary.
- Detect `receipt_review` confirmations even when no new source post exists.
- Ignore historical backfills or regrouped old posts instead of notifying them as fresh events.
- Persist immutable signals and per-target delivery outcomes in Cloudflare Workers KV.
- Retry only retryable failed delivery targets, with backoff and a per-run delivery budget.
- Provide a protected test-notification endpoint that does not fetch AIHOT.
- Support multiple notification channels and multiple targets per channel.
- Provide public status and health endpoints without exposing secrets.
- Include automated tests and GitHub Actions CI.

### Out of scope for V1

- Scraping X/Twitter directly.
- Independently judging whether a Codex reset is true.
- Mirroring or proxying the AIHOT API.
- Bulk redistribution of AIHOT historical data.
- A hosted SaaS version.
- User accounts or a general authentication system.
- Admin dashboard UI.
- Database services other than Workers KV.
- Durable Objects.
- Email delivery.
- Automatic Cloudflare deployment from GitHub Actions.
- A public unauthenticated endpoint that triggers notifications or AIHOT fetches.

## 3. AIHOT attribution, API rules, and licensing boundary

The repository source code will use the **MIT License**.

The MIT License applies only to code authored for this repository. It does not grant rights to AIHOT APIs, AIHOT data, AIHOT content, or third-party source content.

README documentation must clearly state:

- This is an independent community project and is not an official AIHOT project.
- The project is powered by AIHOT's public Codex Reset API.
- AIHOT must be credited for the Codex Reset event aggregation, structuring, translations, and public API used by this project.
- Users remain responsible for complying with AIHOT's current API and data usage rules.
- AIHOT's current public rules allow personal non-commercial use, non-commercial public-interest use, and internal organizational use; external commercial products, paid services, client delivery, proxy APIs, data resale, public mirrors, or bulk redistribution require AIHOT authorization.
- Attribution alone does not constitute commercial or redistribution authorization.
- Third-party source content remains subject to the rights of its original sources.

The implementation must behave as a respectful API client:

- Default polling interval: 30 minutes.
- Conditional GET via ETag.
- No concurrent retry storm.
- On `429`, persist a source backoff deadline derived from `Retry-After` and do not fetch AIHOT again before that deadline.
- On upstream `5xx` or network failure, preserve committed source state and retry on a later Cron run.
- Never advance source commit state after schema validation, persistence, or parsing failure.

## 4. AIHOT API semantics used by the project

V1 expects `schemaVersion === 1`.

Relevant top-level fields:

- `schemaVersion`: API schema version.
- `timezone`: API timezone metadata.
- `checkedAt`: latest successful AIHOT source verification time.
- `historyFrom`: beginning of the provided history window.
- `count`: event count.
- `events`: full event snapshot.

Important event fields:

- `id`: AIHOT event identifier.
- `type`: e.g. `direct_reset` or `reset_credit`.
- `label`: display label.
- `status`: e.g. `announced` or `confirmed`.
- `title`: AIHOT event title.
- `scope`: affected scope.
- `createdAt`: event record timestamp.
- `updatedAt`: AIHOT event-record update timestamp.
- `confirmedAt`: earliest confirmation-post time, not necessarily actual delivery/reset execution time.
- `occurredOn`: independently verified Beijing-time occurrence date when known.
- `confirmationBasis`: `source_post`, `receipt_review`, or null.
- `schedule`: original announced schedule metadata.
- `posts`: source-post list for the event.
- `url`: AIHOT event URL.

Important source-post fields:

- `id`: stable source-post identifier.
- `publishedAt`: actual source-post publication time.
- `stage`: stage represented by that source post.
- `text`: AIHOT Chinese translation.
- `originalText`: relevant original-language excerpt.
- `url`: original source-post URL.

Critical ordering rule:

- `events[0]` must never be assumed to be the newest Tibo/source message because events are ordered by `event.updatedAt`.
- When selecting the globally newest source post, compare all `posts[].publishedAt` values across all events.

## 5. Architecture

Use a lightweight modular Adapter architecture.

```text
Cloudflare Worker entry
        │
        ├── HTTP routes
        └── Cron trigger
             │
             ▼
       AIHOT client
             │
             ▼
   Snapshot validator
             │
             ▼
       Signal detector
             │
             ▼
   KV persistence protocol
             │
             ▼
   Notification dispatcher
             │
     ┌───────┼────────┐
     ▼       ▼        ▼
   WeCom   Feishu   Telegram ...
```

Recommended source layout:

```text
src/
├── index.js
├── aihot/
│   ├── client.js
│   └── validate.js
├── monitor/
│   └── reset-monitor.js
├── state/
│   └── kv-store.js
├── notification/
│   ├── dispatcher.js
│   ├── message.js
│   ├── retry.js
│   └── channels/
│       ├── wework.js
│       ├── feishu.js
│       ├── dingtalk.js
│       ├── telegram.js
│       ├── bark.js
│       ├── ntfy.js
│       ├── slack.js
│       └── generic-webhook.js
└── utils/
    ├── crypto.js
    ├── text.js
    └── time.js
```

Supporting repository structure:

```text
test/
docs/
wrangler.jsonc
package.json
.gitignore
README.md
README_EN.md
LICENSE
```

## 6. KV persistence model

Do **not** store the whole application state in one frequently rewritten JSON key. Workers KV is not a transactional read-modify-write database, and a design that repeatedly rewrites one hot key is incompatible with its write semantics.

V1 uses separate keys with one clear responsibility each.

### `meta:v4`

This is the committed source snapshot boundary. It is written only after all newly detected signals for a validated snapshot have been durably persisted.

Conceptual value:

```json
{
  "stateVersion": 4,
  "etag": "...",
  "watermark": {
    "publishedAt": "2026-09-12T08:09:00Z",
    "postIdsAtPublishedAt": ["123", "456"]
  },
  "sourceCheckedAt": "...",
  "lastCommittedAt": "...",
  "latestNotification": {
    "signalId": "post:123",
    "kind": "source_post",
    "title": "...",
    "content": "...",
    "publishedAt": "...",
    "eventType": "...",
    "eventStatus": "...",
    "scope": "...",
    "sourceUrl": "https://...",
    "aihotUrl": "https://aihot.news/..."
  }
}
```

`latestNotification` is the latest committed real source-post notification and is used by the protected test endpoint. The test endpoint must not fetch AIHOT.

### `signal:<signalId>`

Signals are immutable durable work items.

Conceptual value:

```json
{
  "signalId": "post:123",
  "kind": "source_post",
  "discoveredAt": "...",
  "sortAt": "...",
  "notification": {
    "title": "...",
    "content": "...",
    "publishedAt": "...",
    "eventType": "...",
    "eventStatus": "...",
    "scope": "...",
    "sourceUrl": "https://...",
    "aihotUrl": "https://aihot.news/..."
  },
  "targetIds": [
    "wework:0123456789abcdef0123456789abcdef",
    "telegram:fedcba9876543210fedcba9876543210"
  ]
}
```

A signal must contain the complete canonical notification payload required for future delivery. This is required so pending deliveries remain retryable even when a later AIHOT request returns `304` or the upstream source is temporarily unavailable.

### `delivery:<signalId>:<targetId>`

No delivery key means the target has not yet been attempted and is pending.

When a delivery key exists, its status is one of:

- `sent`
- `retry_wait`
- `permanent_failure`
- `disabled`

Conceptual retry value:

```json
{
  "status": "retry_wait",
  "attemptCount": 2,
  "nextAttemptAt": "...",
  "lastAttemptAt": "...",
  "lastErrorCode": "http_503",
  "lastError": "sanitized error"
}
```

A successful target is written as `sent`. A removed target is written as `disabled` for old signals instead of remaining pending forever.

### `target:<targetId>`

Stores non-secret lifecycle metadata for a configured target:

```json
{
  "channel": "wework",
  "status": "active",
  "enabledAt": "...",
  "disabledAt": null
}
```

Target configuration secrets are never stored here.

### `source:backoff`

Stores AIHOT source rate-limit/backoff state separately from committed source metadata:

```json
{
  "retryNotBefore": "...",
  "reason": "429",
  "updatedAt": "..."
}
```

A source backoff record must be checked before any AIHOT fetch.

### `diag:last`

Stores sanitized operational diagnostics such as Cron timestamps, source-check result, pending/retry counts, and last notification result. It must not contain secrets.

### No hot pending index

V1 does not maintain a frequently rewritten `pending:index` key. Codex Reset event volume is low, so the Worker may enumerate `signal:` keys using KV listing and inspect their delivery keys. Pagination must be supported.

The current invocation must not depend on KV listing immediately reflecting writes from the same invocation; newly created in-memory candidate signals are dispatched directly after commit. KV listing is for later-run recovery/retry.

## 7. Signal model

### Source-post signal

Stable identifier:

```text
post:<post.id>
```

### Receipt-review signal

Stable identifier:

```text
receipt_review:<event.id>
```

V1 treats one AIHOT event's `receipt_review` confirmation as a single logical signal. If the same event is later retracted and reconfirmed under the same event ID, V1 does not emit a second receipt-review notification. A future version may model confirmation epochs if AIHOT exposes a stronger lifecycle contract.

### Canonical notification payload

Business logic creates plain structured data. It does not embed platform-specific Markdown or HTML.

Conceptual shape:

```json
{
  "signalId": "post:123",
  "kind": "source_post",
  "title": "Codex 全员重置动态",
  "eventType": "direct_reset",
  "eventStatus": "confirmed",
  "scope": "...",
  "publishedAt": "...",
  "scheduleLabel": "...",
  "occurredOn": "...",
  "confirmationBasis": "source_post",
  "content": "AIHOT Chinese translation",
  "sourceUrl": "https://...",
  "aihotUrl": "https://aihot.news/..."
}
```

This payload is persisted inside the signal before dispatch.

## 8. Snapshot validation and watermark algorithm

### Validate before classification

For every AIHOT `200` response:

1. Validate `schemaVersion`.
2. Validate required collection shapes.
3. Validate timestamps used by ordering/watermark logic.
4. Detect duplicate `post.id` values with conflicting source data.
5. Reject the snapshot if required invariants fail.

An incompatible schema, invalid ordering timestamp, or conflicting duplicate must not advance ETag or watermark.

### Boundary watermark

The committed watermark is not a timestamp alone. It is:

```json
{
  "publishedAt": "T",
  "postIdsAtPublishedAt": ["id-a", "id-b"]
}
```

This solves both same-timestamp posts and signal-retention pruning.

For an unseen source post relative to committed watermark `W0 = (T0, IDs0)`:

- `publishedAt < T0` → historical backfill/regrouping; do not notify.
- `publishedAt > T0` → new source-post candidate.
- `publishedAt == T0` and `post.id ∉ IDs0` → new source-post candidate.
- `publishedAt == T0` and `post.id ∈ IDs0` → already known boundary post.

### Immutable W0 per snapshot

All candidates in a single AIHOT snapshot must be classified against the same immutable entry watermark `W0`.

Example:

```text
W0 = 10:00
snapshot posts = 10:10, 10:05
```

Both 10:10 and 10:05 are compared to 10:00. The implementation must not advance the watermark while iterating.

Only after classification and durable signal persistence is complete may the Worker compute and commit `W1`.

### W1 construction

`W1.publishedAt` is the maximum valid source-post `publishedAt` in the accepted snapshot.

`W1.postIdsAtPublishedAt` contains all known source-post IDs at exactly that maximum timestamp.

Signal retention must never be used as the only memory of the watermark boundary.

## 9. Source commit protocol

The source commit boundary is normative.

For AIHOT `200`:

```text
fetch snapshot
  ↓
validate entire snapshot
  ↓
read immutable committed W0
  ↓
compute all candidates against W0
  ↓
sort new signals deterministically
  ↓
persist every new immutable signal + targetIds
  ↓
commit meta:v4 with new ETag + W1 + latestNotification
  ↓
dispatch new signals and eligible backlog
  ↓
persist delivery outcomes
```

Rules:

- If validation fails, do not update `meta:v4`.
- If any required new signal write fails before the source commit, do not update `meta:v4`.
- Partially written signal keys are safe: a later retry deduplicates by stable `signalId`.
- Never save a new ETag after an incompatible schema or failed pre-commit persistence step.
- Only the final `meta:v4` write commits the accepted snapshot boundary.
- A later `304` is safe because retryable notification payloads are already stored inside `signal:*` keys.

## 10. Signal ordering

New source-post signals from one snapshot are sent in deterministic chronological order:

```text
(sortAt, signalId) ascending
```

For source-post signals:

```text
sortAt = post.publishedAt
```

For receipt-review signals:

```text
sortAt = event.confirmedAt || event.updatedAt || snapshot.checkedAt
```

This prevents a newer confirmation from being sent before an older announcement merely because AIHOT's snapshot is newest-first.

Per-target delivery order is best-effort across separate Cron invocations; V1 guarantees deterministic scheduling order inside one invocation but does not claim globally transactional ordering across independent external platforms.

## 11. Target model and secret handling

Supported V1 channels:

- WeCom
- Feishu
- DingTalk
- Telegram
- Bark
- ntfy
- Slack
- Generic Webhook

Email is intentionally excluded from V1.

### Configuration names

```text
WEWORK_WEBHOOK_URL
WEWORK_MSG_TYPE
FEISHU_WEBHOOK_URL
DINGTALK_WEBHOOK_URL
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
BARK_URL
NTFY_TOPIC
NTFY_SERVER_URL
NTFY_TOKEN
SLACK_WEBHOOK_URL
GENERIC_WEBHOOK_URL
GENERIC_WEBHOOK_TEMPLATE

ENABLE_TEST_ENDPOINT
TEST_TOKEN
```

Webhook-style values may use `;` to configure multiple targets.

For Telegram, token and chat ID lists are paired by index. A count mismatch is a configuration error.

### Target identity

Canonicalize the target's relevant secret configuration, compute SHA-256, and use the first 128 bits (32 lowercase hex characters) as the target hash.

Examples:

```text
wework:0123456789abcdef0123456789abcdef
telegram:fedcba9876543210fedcba9876543210
```

The project does not introduce an extra HMAC deployment secret in V1. Notification credentials are expected to be high-entropy secrets already, and the target hash is never exposed through public HTTP responses.

### Target lifecycle

When a target is first configured, create/activate its `target:<targetId>` record.

When a previously configured target disappears:

- mark its target record disabled;
- mark matching old pending/retry-wait deliveries `disabled` when encountered;
- exclude them from retry and health pending counts.

If the same target is later re-enabled, it only appears in `targetIds` of signals discovered after reactivation. Historical signals are not replayed merely because a target returns.

Changing the target secret changes its hash and therefore creates a new target identity.

## 12. Delivery retry policy

### Retryable failures

Treat the following as retryable unless a platform-specific response says otherwise:

- network error;
- timeout;
- HTTP `408`;
- HTTP `429`;
- HTTP `5xx`;
- documented platform rate-limit errors.

Use platform `Retry-After` when available. Otherwise use exponential backoff based on a 30-minute base interval, capped at 24 hours.

Conceptual schedule:

```text
30m → 1h → 2h → 4h → 8h → 16h → 24h → 24h
```

After 8 failed attempts, mark the delivery `permanent_failure` and expose it through sanitized diagnostics. Do not retry it forever.

### Non-retryable failures

Treat clearly invalid target/configuration failures as permanent, including typical `400`, `401`, `403`, `404`, or `410` responses, subject to platform-specific semantics.

### Timeout

External channel requests and AIHOT requests must use a finite timeout. V1 default target: 10 seconds per outbound request.

### Per-run delivery budget

Source monitoring has priority over backlog processing.

A Cron invocation must cap external notification attempts. V1 default target: at most 10 delivery attempts per run, including new-signal deliveries and retry backlog.

If more eligible work exists, leave it durable for the next Cron.

## 13. Cron execution flow

Default schedule:

```text
*/30 * * * *
```

Execution order:

1. Load committed `meta:v4` and target configuration.
2. Reconcile target lifecycle metadata.
3. Check `source:backoff` before attempting AIHOT.
4. If upstream backoff has expired or is absent, perform the AIHOT conditional request.
5. Handle AIHOT:
   - `304` → no new source commit required.
   - `200` → validate, classify against immutable W0, persist signals, then commit `meta:v4`.
   - `429` → persist `source:backoff`; do not immediately retry.
   - `5xx` / network failure → preserve committed source state.
   - incompatible/invalid snapshot → preserve committed source state.
6. Build the eligible delivery queue from newly created signals plus durable retry backlog.
7. Sort by signal chronology and respect `nextAttemptAt`.
8. Dispatch up to the per-run delivery budget.
9. Persist per-target results.
10. Persist `diag:last` once at the end of the invocation.

The Worker must not allow a large retry backlog to prevent the source check from running.

## 14. Notification adapters and untrusted-content boundary

AIHOT-returned text, titles, translations, original text, and URLs are treated as untrusted external data.

Canonical notification data remains plain structured text. Each adapter is responsible for safe channel rendering.

Required safeguards:

- escape Telegram HTML when HTML mode is used;
- escape or neutralize channel-specific Markdown/mrkdwn control sequences as needed;
- suppress mass-mention forms such as `@channel`, `@here`, `@everyone`, or platform equivalents when originating from upstream content;
- accept only `http:` and `https:` source links;
- truncate overlong descriptive content while preserving critical metadata and links;
- never interpolate unescaped upstream content directly into executable JSON text.

### Generic Webhook

`GENERIC_WEBHOOK_TEMPLATE` must be parsed as structured JSON first. Placeholder substitution happens only inside string values, followed by `JSON.stringify()` for transmission.

Do not build a JSON body by raw string concatenation with untrusted `{title}` / `{content}` values.

### Platform-level success

Adapters must validate both HTTP status and platform business-success fields where applicable. HTTP 200 with a platform error code is a failed delivery.

## 15. HTTP routes

### `GET /`

Public read-only status endpoint.

Return safe operational information such as:

- service name/version;
- AIHOT attribution/source URL;
- schedule;
- last committed source check;
- AIHOT `checkedAt`;
- latest known source-post publication time;
- last Cron status;
- count of configured targets per channel;
- pending/retry/permanent-failure counts.

Never return credentials, raw target hashes, webhook URLs, bot tokens, chat IDs, or Generic Webhook secrets.

### `GET /health`

Minimal read-only health endpoint with sanitized status only.

### `POST /test/notify`

V1 keeps a test endpoint because deployers need a reliable way to verify notification formatting and target connectivity. It is deliberately separated from source fetching.

Security and behavior rules:

1. The endpoint is disabled by default.
2. It is enabled only when `ENABLE_TEST_ENDPOINT=true`.
3. When enabled, `TEST_TOKEN` is required.
4. The caller must send:

```text
Authorization: Bearer <TEST_TOKEN>
```

5. The endpoint must reject unauthorized requests before reading notification targets or performing any external request.
6. The endpoint must **not fetch AIHOT**.
7. It reads `meta:v4.latestNotification`, which represents the latest committed real source-post notification already obtained by Cron.
8. If no committed latest notification exists yet, return `409` with a sanitized `no_committed_source` reason.
9. It sends the cached notification to currently configured targets and returns sanitized per-channel results.
10. It does not modify automatic signal/delivery state.
11. An optional request body may restrict the test to one channel, for example:

```json
{
  "channel": "wework"
}
```

If omitted, the test targets all configured channels.

12. `GET /test/notify` is not supported.
13. There is no public unauthenticated manual notification endpoint in V1.

This endpoint is for notification-path verification, not for forcing a fresh AIHOT poll.

Deployers who want another layer of protection may place `/test/*` behind Cloudflare Access. That is optional defense-in-depth and not required for portability.

### Unknown routes

Return `404`.

## 16. Migration to V4

Existing deployments may contain earlier monolithic state formats.

When `stateVersion !== 4` or no valid V4 commit exists:

1. Fetch a complete AIHOT snapshot without trusting an incompatible old ETag.
2. Validate the snapshot fully.
3. Build the boundary watermark from all current source posts.
4. Record current `receipt_review:<event.id>` signals as baseline-known without notification.
5. Persist the latest committed source notification into `meta:v4.latestNotification` for testing.
6. Commit `meta:v4` only after baseline preparation succeeds.
7. Do not send historical notifications.
8. Record migration diagnostics as `migrated`.

Migration must not create signal/delivery work for historical source posts.

## 17. Retention and cleanup

Retain completed signal state for approximately 90 days.

A signal can be pruned only when all of its target deliveries are terminal:

- `sent`
- `permanent_failure`
- `disabled`

Retry-wait or never-attempted target work must not be pruned solely because of age.

When pruning a terminal signal, prune its associated delivery keys as well.

The boundary watermark in `meta:v4` is independent of signal retention, so deleting an old signal cannot resurrect a post whose ID is still represented at the watermark boundary.

## 18. Error handling and observability

Store concise sanitized diagnostics, including:

- last Cron start/end;
- last source status;
- last source HTTP/result category;
- current source backoff deadline if any;
- latest committed source time;
- number of active targets;
- pending/retry/permanent-failure counts;
- last successful notification time;
- sanitized last errors.

Never persist full secrets in logs, KV values, errors, or HTTP responses.

## 19. Testing strategy

Use Vitest.

### AIHOT and watermark regression tests

Mandatory tests:

- global latest source post is selected by `posts[].publishedAt`, not `events[0]`;
- two new posts `10:10` and `10:05` are both discovered when entry watermark is `10:00` regardless of iteration order;
- same-timestamp unseen ID is discovered;
- same-timestamp boundary ID is not rediscovered after its signal is pruned;
- historical backfill `< watermark` is not notified;
- conflicting duplicate `post.id` invalidates the snapshot;
- incompatible `schemaVersion` does not advance ETag/watermark;
- receipt-review signal ID is exactly `receipt_review:<event.id>`.

### Commit-protocol tests

Mandatory tests:

- new signal payload is persisted before `meta:v4` advances;
- signal persistence failure leaves old ETag/watermark committed;
- partially persisted stable signals are deduplicated on the next full fetch;
- `304` still allows pending delivery from persisted canonical payload;
- no code path requires two rapid writes to one monolithic state key.

### Delivery tests

Mandatory tests:

- WeCom success + Telegram retryable failure retries only Telegram later;
- `401` / invalid credential becomes permanent failure where applicable;
- `429` respects target retry timing;
- retry attempts advance exponential backoff;
- the eighth failed retryable attempt becomes terminal `permanent_failure`;
- disabled targets do not remain pending;
- re-enabled targets do not receive historical signals;
- per-run delivery budget is enforced;
- source polling is not starved by backlog.

### Adapter safety tests

Mock `fetch()` and verify:

- WeCom payload/result;
- Feishu payload/result;
- DingTalk payload/result;
- Telegram payload/result;
- Bark payload/result;
- ntfy payload/result;
- Slack payload/result;
- Generic Webhook payload/result;
- upstream markup is escaped;
- mass mentions are neutralized;
- non-http(s) URLs are rejected/omitted;
- Generic Webhook substitution cannot break JSON structure;
- HTTP 200 plus platform business error is treated as failure.

### Route tests

Mandatory tests:

- `/` and `/health` never expose secrets or target hashes;
- `POST /test/notify` is unavailable by default;
- enabled test endpoint without valid bearer token returns unauthorized before external requests;
- authorized test reads only committed cached notification data and does not fetch AIHOT;
- authorized test can restrict delivery to one channel;
- test endpoint does not mutate automatic delivery state;
- `GET /test/notify` is rejected;
- unknown routes return 404.

## 20. CI

GitHub Actions initially runs only quality checks:

```text
npm test
npm run lint
```

Run on pull requests and pushes to `main`.

Do not require a Cloudflare API token or auto-deploy from GitHub Actions in V1.

## 21. Documentation requirements

Provide:

- `README.md` — Chinese primary documentation.
- `README_EN.md` — English documentation.
- Cloudflare Workers quick start.
- KV binding instructions using `CODEX_RESET_STATE`.
- Secret configuration for every supported channel.
- Cron configuration.
- Test-endpoint setup with `ENABLE_TEST_ENDPOINT` and `TEST_TOKEN`.
- Explicit warning that the test endpoint must not be exposed without its bearer token.
- Optional Cloudflare Access hardening guidance.
- Troubleshooting/FAQ.
- AIHOT attribution and API/data-usage statement.
- Security guidance: never commit real webhook URLs, bot tokens, `.env`, or `.dev.vars`.

README must describe the project as an independent community project, not an official AIHOT product.

## 22. Security requirements

- Keep credential-bearing values in Cloudflare Secrets or local ignored environment files.
- `.gitignore` must exclude `.env*`, `.dev.vars*`, `.wrangler/`, and dependency/build artifacts as appropriate.
- Never expose secrets through status endpoints.
- Never use raw secrets as delivery-state identifiers.
- Target IDs use at least 128 bits of SHA-256 output.
- Never log complete target credentials.
- Treat all upstream AIHOT-rendered text as untrusted content.
- Generic Webhook templates use structured substitution.
- The test endpoint uses POST, is disabled by default, requires a bearer token when enabled, and never fetches AIHOT.
- A source `Retry-After` deadline is checked before every AIHOT fetch.

## 23. Success criteria for V1

V1 is complete when:

1. A new AIHOT Codex source post is discovered and delivered once to each active target.
2. Multiple new posts in one snapshot are all classified against the same immutable W0 and none are lost because of iteration order.
3. Same-timestamp source posts are deduplicated by the boundary ID set even after old signal pruning.
4. A `receipt_review` confirmation without a new source post can produce one stable signal.
5. Historical AIHOT backfills do not create false fresh alerts.
6. Newly detected signals with complete canonical payloads are durable before ETag/watermark advances.
7. AIHOT `304` responses do not prevent pending delivery retries.
8. Partial target failures do not resend successful targets.
9. Retryable failures back off; invalid credentials do not retry forever.
10. Notification backlog cannot starve source monitoring.
11. Removed/re-added targets do not receive unintended historical replay.
12. External text cannot inject platform markup, mass mentions, unsafe URLs, or malformed Generic Webhook JSON.
13. No public HTTP route exposes credentials or target secret hashes.
14. The test endpoint is disabled by default, requires bearer authorization when enabled, and never amplifies AIHOT traffic.
15. V4 migration does not replay historical notifications.
16. README clearly credits AIHOT and explains the independent code-license/API-use boundary.

## 24. Future extensions

Potential future work, not required for V1:

- Email delivery.
- Additional adapters such as Gotify or PushDeer.
- Optional Cloudflare Workers Rate Limiting binding for test/admin routes.
- Optional Cloudflare Access recipes for browser-authenticated operator access.
- Durable Objects only if future features require strict coordination or transactional counters.
- Optional GitHub-to-Cloudflare automatic deployment.
- Richer operational dashboard.
- A dedicated authenticated endpoint to force a fresh AIHOT poll, if a real operational need emerges later.

These extensions must not weaken AIHOT attribution, API-use compliance, source commit invariants, secret isolation, or the per-target delivery-state model.
