# AIHOT Reset Relay — Design Specification

Date: 2026-09-16
Status: Approved design baseline
Repository: `LewLIu/aihot-reset-relay`

## 1. Purpose

AIHOT Reset Relay is a self-hosted Cloudflare Workers project that monitors AIHOT's public Codex Reset API and relays new Codex reset information to user-configured notification channels.

The project does **not** collect posts from X/Twitter, independently determine whether a Codex reset happened, mirror AIHOT's API, or provide a hosted SaaS service. AIHOT is the upstream source of structured Codex Reset data; this project is responsible for polling, state tracking, deduplication, delivery retries, and channel-specific notification formatting.

Primary data flow:

```text
Tibo / upstream sources
        ↓
      AIHOT
        ↓
AIHOT Codex Reset API
        ↓
aihot-reset-relay
        ↓
WeCom / Feishu / DingTalk / Telegram / Bark / ntfy / Slack / Generic Webhook
```

## 2. Scope and product constraints

### In scope

- Monitor `https://aihot.news/api/v1/codex-resets`.
- Poll every 30 minutes using a Cloudflare Cron Trigger.
- Use ETag / `If-None-Match` conditional requests.
- Respect AIHOT rate-limit responses, including `429` and `Retry-After`.
- Detect new source posts using `posts[].id`.
- Use `posts[].publishedAt` as the source-post time watermark.
- Detect `receipt_review` confirmations even when no new source post exists.
- Ignore historical backfills or regrouped old posts instead of notifying them as new.
- Persist delivery state in Cloudflare Workers KV.
- Retry only failed delivery targets on later Cron runs.
- Provide a manual `/latest` endpoint that sends the current latest real source post to all configured targets.
- Apply a best-effort 10-second debounce to repeated `/latest` requests for the same post.
- Support multiple notification channels and multiple targets per supported channel.
- Provide a public status endpoint and health endpoint without exposing secrets.
- Include automated tests and GitHub Actions CI.

### Out of scope for V1

- Scraping X/Twitter directly.
- Independently judging whether a Codex reset is true.
- Mirroring or proxying the AIHOT API.
- Bulk redistribution of AIHOT historical data.
- A hosted SaaS version.
- User accounts or authentication systems.
- Admin dashboard UI.
- Database services other than Workers KV.
- Email delivery.
- Automatic Cloudflare deployment from GitHub Actions.
- Strong authentication for `/latest`.

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

The implementation should behave as a respectful API client:

- Default polling interval: 30 minutes.
- Conditional GET via ETag.
- No concurrent retry storm.
- On `429`, record the condition and honor `Retry-After` semantically; do not immediately hammer the API.
- Preserve existing local state on upstream failures.

## 4. AIHOT API semantics used by the project

The implementation must rely on confirmed API schema semantics rather than positional assumptions.

Relevant top-level fields:

- `schemaVersion`: API schema version. V1 expects version `1`.
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

- `events[0]` must **never** be assumed to be the newest Tibo/source message because events are ordered by `event.updatedAt`.
- Within an event, source posts are newest-source-first, but the project will still compare `publishedAt` values when finding the global latest source post.

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
       Signal detector
             │
             ▼
        KV state store
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
│   └── client.js
├── monitor/
│   └── reset-monitor.js
├── state/
│   └── kv-store.js
├── notification/
│   ├── dispatcher.js
│   ├── message.js
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

## 6. Signal model

The monitor produces persistent notification signals rather than a simple `seenPostIds` set.

### Source-post signal

Stable identifier:

```text
post:<post.id>
```

A source-post signal represents a newly published source post returned by AIHOT.

### Receipt-review signal

`receipt_review` may confirm an event without a new confirmation source post. It therefore requires a separate signal type.

A stable receipt-review signal should be derived from:

- signal kind: `receipt_review`
- event type
- a stable event/source anchor

It must not contain secrets.

### Historical backfill protection

Maintain a source-post publication watermark, `latestPublishedAt`.

For an unseen `post.id`:

- if `post.publishedAt` is newer than the watermark, create a new notification signal;
- if it is older than the watermark, treat it as historical backfill/regrouping, record it as known, and do not notify.

This prevents AIHOT historical corrections from appearing as fresh Codex alerts.

## 7. Persistent delivery queue and state

State version for the new architecture: `4`.

Conceptual state:

```json
{
  "stateVersion": 4,
  "etag": "...",
  "latestPublishedAt": "...",
  "sourceCheckedAt": "...",
  "lastCheck": "...",
  "lastNotificationAt": "...",
  "signals": {
    "post:123456": {
      "kind": "source_post",
      "publishedAt": "...",
      "eventType": "direct_reset",
      "deliveries": {
        "wework:<targetHash>": {
          "status": "sent",
          "sentAt": "..."
        },
        "telegram:<targetHash>": {
          "status": "pending",
          "lastError": "..."
        }
      }
    }
  }
}
```

### Delivery guarantees

The design targets **at-least-once processing with per-target delivery state**, not exactly-once semantics.

Rules:

1. Detect a new signal.
2. Persist the signal and its pending deliveries before sending.
3. Attempt each pending target independently.
4. Mark a target `sent` only after the target-specific adapter confirms success.
5. Leave failed targets `pending` with diagnostic error metadata.
6. Future Cron runs retry only pending targets.
7. Already successful targets are not resent.

A partial failure such as:

```text
WeCom    sent
Feishu   sent
Telegram pending
```

must result in only Telegram being retried later.

### ETag and delivery retry are independent

After a successful AIHOT `200` response, newly detected signals are persisted before delivery and the new source snapshot/ETag can be accepted.

If the next AIHOT request returns `304`, pending deliveries must still be processed from KV.

Therefore notification retries do not depend on receiving the same upstream event again.

### Retention

Retain approximately 90 days of completed signal state. Old completed signals may be pruned to prevent unbounded KV growth. Pending signals must never be removed merely because they are old.

## 8. Target model and secret handling

A channel may have multiple configured delivery targets.

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

Use familiar environment/secret names:

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
```

Unset channels are silently skipped.

### Multiple targets

Webhook-style values may use `;` as a separator for multiple accounts/targets.

For Telegram, token and chat ID lists are paired by index. A count mismatch is a configuration error and must be surfaced in status/diagnostics rather than guessed.

### Target identity

Do not put webhook URLs, bot tokens, chat IDs, or other secrets into KV delivery keys.

Generate a target identifier from a cryptographic SHA-256 digest of the target's relevant secret configuration and store only a short non-reversible prefix, for example:

```text
wework:<hash-prefix>
telegram:<hash-prefix>
```

Changing a webhook or token therefore creates a new target identity without exposing credentials.

### New targets do not receive historical alerts

When a new target is configured, existing historical signals must not be replayed to it. The target begins receiving signals discovered after it becomes active.

## 9. Notification abstraction

Business logic produces a structured notification object, not channel-specific Markdown.

Conceptual notification model:

```json
{
  "signalId": "post:123456",
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

Each channel adapter converts that structure into the channel's native format.

Adapter responsibilities:

- discover configured targets for its channel;
- format content appropriately;
- apply safe length limits;
- send via `fetch`;
- validate both HTTP-level and platform-level success;
- return a normalized result.

The V1 notification body should remain concise. Do not implement TrendRadar-style multi-batch report delivery yet. If content exceeds a channel's safe size, truncate the descriptive body while preserving title, critical status/time metadata, and source links.

## 10. Channel-specific expectations

### WeCom

- Default: Markdown group-bot message.
- Optional `WEWORK_MSG_TYPE=text` for plain-text/personal-WeChat-compatible scenarios.
- Platform-level `errcode` must be checked.

### Feishu

- Use webhook-compatible text or interactive Markdown card depending on the endpoint form supported by the adapter.
- Validate Feishu's returned success code.

### DingTalk

- Use Markdown robot payload.
- Validate returned `errcode`.

### Telegram

- Use Bot API `sendMessage`.
- Render safe HTML or plain text.
- Disable link preview by default for concise alerts.
- Token/chat configuration pairs by index.

### Bark

- Use Bark's JSON push API.
- Keep mobile notification content short.

### ntfy

- Support `NTFY_TOPIC`.
- Default server: `https://ntfy.sh` when no server is configured.
- Optional Bearer token.

### Slack

- Use Incoming Webhook.
- Render Slack-compatible mrkdwn.

### Generic Webhook

- Support `GENERIC_WEBHOOK_URL`.
- Optional `GENERIC_WEBHOOK_TEMPLATE` with at least `{title}` and `{content}` placeholders.
- Default JSON shape when no template is configured:

```json
{
  "title": "{title}",
  "content": "{content}"
}
```

This adapter provides an extension path for Discord, Matrix, IFTTT, self-hosted services, and unsupported webhook platforms.

## 11. Cron execution flow

Default schedule:

```text
*/30 * * * *
```

Execution order:

1. Load state from KV.
2. Retry existing pending delivery targets.
3. Request AIHOT using the stored ETag when appropriate.
4. Handle upstream response:
   - `304`: no new upstream snapshot; continue with local state only.
   - `200`: validate schema and parse snapshot.
   - `429`: do not immediately retry; record rate-limit information and preserve state.
   - `5xx` or network failure: preserve state; try again next Cron.
   - unexpected incompatible schema: do not generate new signals.
5. Detect new source-post and receipt-review signals.
6. Persist new signals and pending targets before sending.
7. Dispatch pending deliveries.
8. Persist per-target outcomes.
9. Update Cron diagnostic record.

One Cron invocation should not perform aggressive multi-retry loops. Persistent pending state provides the retry mechanism at the next scheduled run.

## 12. HTTP routes

### `GET /`

Public status endpoint.

Return safe operational information such as:

- service name/version;
- AIHOT attribution/source URL;
- schedule;
- last check;
- AIHOT `checkedAt`;
- latest known source-post publication time;
- last Cron status;
- count of configured targets per channel;
- pending delivery count.

Never return:

- webhook URLs;
- bot tokens;
- chat IDs;
- ntfy tokens;
- Generic Webhook payload secrets;
- target secret hashes.

### `GET /health`

Minimal health endpoint.

Healthy example:

```json
{
  "ok": true,
  "service": "aihot-reset-relay"
}
```

If recent monitoring state indicates a material source-check failure, return an unhealthy diagnostic reason without exposing secrets.

### `GET /latest`

Manual action endpoint.

Behavior:

1. Fetch the current AIHOT snapshot.
2. Traverse all events and source posts.
3. Select the globally newest post by `publishedAt`.
4. Send it immediately to every currently configured target.
5. Do not modify automatic Cron signal/delivery state.
6. Return per-channel/target success information using safe display labels rather than secret hashes.

#### 10-second debounce

Persist a small manual debounce record:

```json
{
  "postId": "...",
  "sentAt": "..."
}
```

If the same post is requested again within 10 seconds, return `duplicate: true` and do not send again.

Workers KV is eventually consistent, so this debounce is explicitly best-effort and is intended to prevent accidental double-click/preview-refresh duplicates, not to act as a security control or distributed lock.

`/latest` remains intentionally unauthenticated in V1. README must warn deployers not to publicize their production Worker URL if this behavior is undesirable.

Manual `/latest` failures are returned immediately and are **not** converted into persistent automatic retry jobs.

## 13. State migration

Existing personal deployments may contain earlier state formats.

When `stateVersion !== 4`:

1. Fetch a complete AIHOT snapshot without relying on an incompatible old ETag.
2. Build a V4 baseline from all current source posts and existing receipt-review confirmations.
3. Set the publication watermark from the current snapshot.
4. Mark historical data as baseline/known.
5. Do not send historical notifications.
6. Report migration status as `migrated`.

This avoids a one-time flood of old Codex alerts after upgrading.

## 14. Error handling and observability

Store concise diagnostic state, including:

- last Cron start/end;
- last source-check status;
- last successful notification time;
- pending delivery count;
- failed target count;
- sanitized error messages where useful;
- AIHOT `checkedAt`;
- rate-limit metadata when applicable.

Never persist full secrets in logs, KV state, errors, or HTTP responses.

Channel failures are isolated. One failed target must not roll back or duplicate successful target deliveries.

## 15. Testing strategy

Use Vitest.

### AIHOT/parser regression tests

Use a fixed fixture such as:

```text
test/fixtures/aihot-response.json
```

Test at least:

- latest source post is selected by `posts[].publishedAt`;
- `events[0]` is not treated as the newest source message;
- source-post signal IDs use `post.id`;
- receipt-review signals are generated correctly;
- historical backfills are recorded without notification;
- unknown incompatible `schemaVersion` does not generate new signals.

The `events[0]` regression test is mandatory because this bug was observed during prototype development.

### State and retry tests

Test:

- V3/older state to V4 migration does not send historical notifications;
- new signals are persisted before delivery;
- WeCom success + Telegram failure leaves only Telegram pending;
- next Cron retries only Telegram;
- AIHOT `304` does not block retrying pending deliveries;
- newly configured targets do not receive historical signals;
- completed signals older than retention period can be pruned;
- pending signals are retained regardless of age.

### Adapter tests

Mock `fetch()` and verify payloads/results for:

- WeCom;
- Feishu;
- DingTalk;
- Telegram;
- Bark;
- ntfy;
- Slack;
- Generic Webhook.

Verify that HTTP 200 combined with a platform business-error response is treated as failure where applicable.

### Route tests

Test:

- `/` never leaks configured secrets;
- `/health` returns sanitized health status;
- `/latest` chooses the real newest source post;
- repeated `/latest` within 10 seconds is skipped;
- `/latest` does not mutate automatic delivery state;
- unknown routes return 404.

## 16. CI

GitHub Actions should initially run only quality checks:

```text
npm test
npm run lint
```

Run on pull requests and pushes to `main`.

Do not require a Cloudflare API token or auto-deploy from GitHub Actions in V1.

## 17. Documentation requirements

Provide:

- `README.md` — Chinese primary documentation.
- `README_EN.md` — English documentation.
- Quick start for Cloudflare Workers.
- KV binding instructions using `CODEX_RESET_STATE`.
- Secret configuration for every supported channel.
- Cron configuration.
- `/latest` behavior and unauthenticated-endpoint warning.
- Troubleshooting/FAQ.
- AIHOT attribution and API/data-usage statement.
- Security guidance: never commit real webhook URLs, bot tokens, `.env`, or `.dev.vars`.

README should explicitly describe the project as an independent community project, not an official AIHOT product.

## 18. Security requirements

- Keep all credential-bearing values in Cloudflare Secrets or local ignored environment files.
- `.gitignore` must exclude `.env*`, `.dev.vars*`, `.wrangler/`, and dependency/build artifacts as appropriate.
- Never expose secrets through status endpoints.
- Never use raw secrets as delivery-state identifiers.
- Never log complete target credentials.
- Generic Webhook templates must be parsed safely and failures must not expose configured secrets.
- The public `/latest` endpoint is a deliberate usability/security trade-off; its 10-second debounce is not authentication.

## 19. Success criteria for V1

V1 is complete when:

1. A new AIHOT Codex source post is discovered and delivered once to each configured target.
2. A `receipt_review` confirmation without a new source post can produce a notification.
3. Historical AIHOT backfills do not create false fresh alerts.
4. Failed individual targets retry later without resending successful targets.
5. AIHOT `304` responses do not prevent pending delivery retries.
6. `/latest` sends the actual latest source post and suppresses accidental same-post calls within 10 seconds.
7. No HTTP route, KV key, committed file, or log exposes notification credentials.
8. V4 migration does not replay historical notifications.
9. All supported adapters have automated payload/success/failure tests.
10. README clearly credits AIHOT and explains the independent licensing/API-use boundary.

## 20. Future extensions

Potential future work, not required for V1:

- Email delivery.
- Additional adapters such as Gotify or PushDeer.
- Strong authentication for manual endpoints.
- Durable Objects if strict cross-PoP debounce/locking becomes necessary.
- Optional GitHub-to-Cloudflare automatic deployment.
- Richer operational dashboard.

These extensions must not weaken AIHOT attribution, API-use compliance, secret isolation, or the per-target delivery-state model.
