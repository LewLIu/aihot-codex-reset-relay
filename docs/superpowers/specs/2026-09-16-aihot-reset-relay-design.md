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
- Respect AIHOT rate limiting and upstream backoff, including `Retry-After` where present.
- Detect new source posts using `posts[].id`.
- Use `posts[].publishedAt` as the source-post chronology boundary.
- Detect anchored `receipt_review` confirmations even when no new confirmation source post exists.
- Ignore historical backfills or regrouped old posts instead of notifying them as fresh events.
- Persist immutable signals and per-target delivery outcomes in Cloudflare Workers KV.
- Retry only retryable failed delivery targets, with backoff and a per-run delivery budget.
- Provide an authenticated `GET /latest` operator endpoint that performs a fresh AIHOT fetch and sends the real latest source post to configured notification targets.
- Keep `/latest` convenient for mobile use by allowing the authenticated URL to be bookmarked directly.
- Support multiple notification channels and multiple targets per channel.
- Bound outbound delivery concurrency while preserving per-target signal ordering.
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
- Distributed exactly-once delivery guarantees across Cloudflare locations.

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
- Any response that carries a valid `Retry-After` must establish a source backoff deadline that Cron and `/latest` both obey before any further AIHOT fetch.
- `429` always uses `Retry-After` when present.
- `503` and other upstream failures use `Retry-After` when present; otherwise `5xx` and network failures use exponential source backoff.
- Successful `200` or `304` resets the consecutive source-failure counter and clears expired failure backoff state.
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

- `id`: AIHOT event identifier. V1 does **not** assume this is a permanent logical-event identity across all future regrouping/correction behavior.
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

- `id`: stable source-post identifier used by this project for source-post deduplication and receipt-review anchoring.
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
  "lastCommittedAt": "..."
}
```

### `signal:<signalId>`

Signals are immutable durable work items.

Conceptual source-post value:

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

Receipt-review signals additionally persist their anchoring metadata, including the canonical anchor post ID and the source-post IDs observed in the event at creation time.

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

Stores source retry state separately from committed source metadata:

```json
{
  "attemptCount": 2,
  "retryNotBefore": "...",
  "lastStatus": 503,
  "lastFailureAt": "...",
  "reason": "upstream_5xx",
  "updatedAt": "..."
}
```

Rules:

- Check this key before **every** AIHOT fetch, including `/latest`.
- A valid `Retry-After` sets `retryNotBefore` directly according to the upstream instruction.
- Without `Retry-After`, source failures use deterministic exponential backoff: `5m → 10m → 20m → 40m → 80m → 160m → 320m → 6h`, capped at 6 hours.
- Successful `200` or `304` resets the source-failure counter and removes or neutralizes expired source backoff state.
- Source backoff is independent from notification-target retry state.

### `manual:latest`

Stores only best-effort accidental-repeat protection for the authenticated manual route:

```json
{
  "lastAcceptedAt": "..."
}
```

Rules:

- `/latest` checks this cooldown record **after authentication but before any AIHOT fetch**.
- If the previous accepted invocation was less than 10 seconds ago, return a sanitized duplicate/cooldown response and do not call AIHOT or notification targets.
- This record is not an authentication mechanism and is not relied upon for abuse prevention.
- Workers KV is eventually consistent, so the cooldown is best-effort and intended to absorb double taps, browser refreshes, and preview reloads.

### `diag:last`

Stores sanitized operational diagnostics such as Cron timestamps, source-check result, pending/retry counts, receipt-review anchoring warnings, legacy-migration warnings, and last notification result. It must not contain secrets.

### No hot pending index

V1 does not maintain a frequently rewritten `pending:index` key. Codex Reset event volume is low, so the Worker may enumerate `signal:` keys using KV listing and inspect their delivery keys. Pagination must be supported.

The current invocation must not depend on KV listing immediately reflecting writes from the same invocation; newly created in-memory candidate signals are dispatched directly after commit. KV listing is for later-run recovery/retry.

### Eventual consistency boundary

Workers KV is eventually consistent across locations. V1 therefore does not use KV as a distributed lock or claim that two overlapping Worker executions can observe each other's just-written delivery state immediately.

Consequences:

- stable immutable `signalId` values remain the source of logical deduplication;
- a stale read by an overlapping execution can still cause the same target to be sent the same signal twice before the `sent` delivery record becomes visible;
- metadata such as `meta:v4` may be observed stale by another location for a short period;
- the design prioritizes avoiding silent data loss over pretending that KV can provide distributed exactly-once coordination.

Durable Objects remain out of scope for V1 because this project accepts the resulting rare duplicate window.

## 7. Signal model

### Source-post signal

Stable identifier:

```text
post:<post.id>
```

### Receipt-review signal

A receipt-review candidate exists when:

```text
event.status == "confirmed"
&& event.confirmationBasis == "receipt_review"
```

V1 does **not** use `event.id` alone as the durable receipt-review dedupe identity because the public API contract does not guarantee that an event ID remains the same logical identity across every future regrouping/correction.

#### Exact anchor algorithm

1. Collect the event's source posts with valid `post.id` and valid `publishedAt`.
2. Sort them by `(publishedAt, post.id)` ascending.
3. The first post becomes `anchorPostId`.
4. The canonical signal ID is:

```text
receipt_review:<event.type>:<anchorPostId>
```

5. Persist all source-post IDs observed in that event as `receiptAnchorPostIds` inside the immutable signal.

Before creating a new receipt-review signal, the detector must also inspect existing receipt-review signals for the same `event.type`. If an existing signal's `receiptAnchorPostIds` intersects the current event's source-post IDs, treat the current candidate as the same logical receipt-review confirmation and do not emit a duplicate even if regrouping changed the canonical first post.

If a receipt-review event has **no valid source post to anchor to**, V1 does not automatically notify it. Record a sanitized `unanchored_receipt_review` diagnostic and wait for a later snapshot that provides an anchor or a future upstream contract that supplies a stronger durable identity. This conservative rule avoids inventing a dedupe identity from mutable event metadata.

If a previously anchored receipt-review event is later corrected, withdrawn, or regrouped:

- existing sent receipt-review signals are not retroactively retracted from notification targets;
- a later confirmed snapshot is not re-notified when source-post overlap links it to an existing receipt signal;
- if no source-post overlap survives, V1 cannot prove logical continuity and treats the candidate according to the normal anchor algorithm, while recording sanitized correction/regrouping diagnostics when detectable.

#### Receipt-review notification payload

Receipt-review notifications use a dedicated normalized payload rather than pretending a new source post exists:

```json
{
  "kind": "receipt_review",
  "eventType": "direct_reset",
  "eventStatus": "confirmed",
  "title": "...",
  "scope": "...",
  "occurredOn": "...",
  "confirmationBasis": "receipt_review",
  "observedAt": "<snapshot.checkedAt>",
  "content": "AIHOT 已通过 receipt review 确认该 Codex 重置事件。",
  "sourceUrl": null,
  "aihotUrl": "<event.url>"
}
```

`publishedAt` is not invented for receipt-review signals. Their `sortAt` uses the ordering rule in section 10.

### Canonical notification payload

Business logic creates plain structured data. It does not embed platform-specific Markdown or HTML.

Conceptual source-post shape:

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

This payload is persisted inside the signal before automatic dispatch. The manual `/latest` route builds the same source-post canonical structure from its freshly fetched AIHOT snapshot but does not create or mutate automatic signal/delivery state.

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

For AIHOT `200` in the automatic monitoring path:

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
commit meta:v4 with new ETag + W1
  ↓
dispatch new signals and eligible backlog
  ↓
persist delivery outcomes
```

Rules:

- If validation fails, do not update `meta:v4`.
- If any required new signal write fails before the source commit, do not update `meta:v4`.
- Partially written signal keys are safe: a later retry deduplicates by stable `signalId` and receipt-review overlap rules.
- Never save a new ETag after an incompatible schema or failed pre-commit persistence step.
- Only the final `meta:v4` write commits the accepted automatic snapshot boundary.
- A later `304` is safe because retryable notification payloads are already stored inside `signal:*` keys.
- Manual `/latest` is intentionally read-and-send only with respect to automatic source state: it does not advance ETag, watermark, signal keys, or automatic delivery keys.

The commit protocol is intentionally crash-recoverable rather than transactional. If two source executions overlap, either may observe stale `meta:v4`; stable signal IDs and immutable signal writes must make later full-snapshot processing converge without silently losing source posts. V1 accepts that overlapping execution can create duplicate work or temporary metadata regression and tests recovery from that condition; it does not emulate a transaction using KV.

## 10. Signal ordering

New signals from one snapshot are sent in deterministic chronological order:

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

This prevents a newer confirmation from being scheduled before an older announcement merely because AIHOT's snapshot is newest-first.

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

LATEST_ACCESS_KEY
```

`LATEST_ACCESS_KEY` is mandatory for the `/latest` route and must be stored as a Cloudflare Secret, not a plaintext committed variable. It must be a cryptographically random high-entropy value; V1 recommends at least 256 random bits encoded using a URL-safe representation such as Base64URL.

### Multi-target configuration contract

V1 uses semicolon-separated environment values for multi-target configuration.

Parsing rules for every semicolon-list value:

1. Literal `;` separates targets.
2. A literal semicolon that belongs inside a URL or field value must be percent-encoded as `%3B` before configuration.
3. Trim surrounding whitespace from every list element.
4. Empty elements are invalid configuration; never silently skip them.
5. Configuration errors are exposed only through sanitized diagnostics/status and never echo secret values.

Webhook-style channels use one target per URL element:

```text
WEWORK_WEBHOOK_URL=url1;url2
FEISHU_WEBHOOK_URL=url1;url2
DINGTALK_WEBHOOK_URL=url1;url2
BARK_URL=url1;url2
SLACK_WEBHOOK_URL=url1;url2
GENERIC_WEBHOOK_URL=url1;url2
```

`WEWORK_MSG_TYPE` is a single global rendering mode for all configured WeCom targets in V1.

Telegram uses positional pairing:

```text
TELEGRAM_BOT_TOKEN=token1;token2
TELEGRAM_CHAT_ID=chat1;chat2
```

The two lists must have exactly the same non-zero length. Any mismatch is a configuration error; the implementation must not guess, reuse the last value, or silently drop entries.

ntfy uses `NTFY_TOPIC` as the target-count authority:

```text
NTFY_TOPIC=topic1;topic2
NTFY_SERVER_URL=https://ntfy.sh
NTFY_TOKEN=token
```

For `N = number of topics`:

- `NTFY_TOPIC` must contain at least one non-empty topic to enable ntfy.
- `NTFY_SERVER_URL` omitted → use `https://ntfy.sh` for every topic.
- `NTFY_SERVER_URL` contains one value → broadcast that server to all N topics.
- `NTFY_SERVER_URL` contains N values → pair by index.
- Any other server-list length is a configuration error.
- `NTFY_TOKEN` omitted → unauthenticated target(s).
- `NTFY_TOKEN` contains one value → broadcast that token to all N topics.
- `NTFY_TOKEN` contains N values → pair by index.
- Any other token-list length is a configuration error.

The same expansion rules are deterministic: once expanded, every configured target has exactly one canonical target configuration before hashing.

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

## 12. Delivery semantics and retry policy

### Delivery guarantee

V1 provides **at-least-once** delivery semantics, not exactly-once delivery.

Expected guarantee:

> A durable signal is eventually delivered at least once to each eligible active target, subject to retry limits and permanent failures. After a successful delivery has been durably recorded as `sent` and that record is visible to the executing location, the relay does not intentionally resend that signal to the same target.

Known duplicate windows:

1. **Crash-before-ack persistence:** an external platform accepts a message successfully but the Worker crashes before persisting `delivery:... = sent`.
2. **Overlapping execution with stale KV read:** another Worker execution in a different location temporarily does not observe the newly written `sent` record because Workers KV is eventually consistent.

In either case, the same target can receive a duplicate. Most webhook platforms do not provide a usable end-to-end idempotency key, so V1 documents and accepts this limitation instead of claiming exactly-once delivery.

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

### Bounded delivery concurrency and ordering

V1 uses a maximum of **3 concurrent target streams** per Worker invocation.

A target stream is identified by `targetId`. Within one target stream, signals are processed strictly serially in `(sortAt, signalId)` ascending order. Different target streams may execute concurrently up to the global limit of 3.

This means:

- the implementation must not `Promise.allSettled()` an unbounded set of deliveries;
- one slow/bad webhook cannot monopolize every outbound slot;
- two messages for the same target are not intentionally reordered by local concurrency;
- independent targets can still make progress in parallel;
- the per-run delivery budget of 10 remains a separate cap on total attempts.

The manual `/latest` route contains one notification only, so it may send to at most 3 target streams concurrently and continues until all currently configured targets have one result; it does not create persistent delivery work.

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
   - `304` → reset source-failure count; no new source commit required.
   - `200` → validate, classify against immutable W0, persist signals, commit `meta:v4`, and reset source-failure count.
   - `429` → persist source backoff using `Retry-After` when present; do not immediately retry.
   - `503` / other `5xx` → use `Retry-After` when present, otherwise persist exponential source backoff; preserve committed source state.
   - network failure / timeout → persist exponential source backoff; preserve committed source state.
   - incompatible/invalid snapshot → preserve committed source state; do not advance ETag/watermark.
6. Build the eligible delivery queue from newly created signals plus durable retry backlog.
7. Group eligible work into per-target streams, preserving `(sortAt, signalId)` order inside each stream.
8. Dispatch up to 3 target streams concurrently while respecting the per-run delivery budget and each delivery's `nextAttemptAt`.
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

### `GET /latest`

V1 keeps `/latest` as a mobile-friendly full-path test and operator endpoint. It intentionally performs a fresh AIHOT fetch so a legal user can verify the complete path:

```text
AIHOT → Worker validation → latest-post selection → notification adapters → configured targets
```

The route remains `GET` so the complete authenticated URL can be saved as a browser bookmark or added to a phone home screen.

#### No-side-effect request guards

Before authentication or any external request:

- `HEAD /latest` must never trigger AIHOT or notification traffic; return `405 Method Not Allowed` with `Allow: GET`.
- A request whose `Sec-Purpose` or legacy `Purpose` header indicates `prefetch` or `prerender` must not trigger side effects; return `204 No Content` (or an equivalent sanitized no-side-effect response).
- These guards exist to prevent browser speculative loading, link scanners, or preview systems from firing a side-effecting bookmarked GET.

Only a real `GET` continues to authentication.

#### Authentication

The caller must provide:

```text
GET /latest?key=<LATEST_ACCESS_KEY>
```

Security rules:

1. `LATEST_ACCESS_KEY` is required; there is no unauthenticated fallback.
2. For a real GET, the key must be validated before reading notification targets, checking source data, or making any external request.
3. Missing or incorrect keys return `403` immediately.
4. Authentication failure must never trigger an AIHOT request or notification request.
5. The implementation must never log the provided key, raw query string, or complete request URL.
6. Public status/health responses never reveal whether a candidate key is close to or derived from the real key.
7. The key can be rotated at any time by replacing the Cloudflare Secret; old bookmarked URLs then become invalid.

A static high-entropy capability URL is an explicit usability/security trade-off chosen for mobile convenience. V1 does not use MD5, TOTP, or per-request HMAC signatures because those would add manual steps without improving the practical security of a bookmarked static operator link.

#### Pre-fetch abuse controls

After authentication and **before fetching AIHOT**:

1. Check `manual:latest`.
2. If the last accepted manual call was less than 10 seconds ago, return a sanitized cooldown response and do not call AIHOT or any notification target.
3. Check `source:backoff`.
4. If source backoff is active — whether created from `429`, `Retry-After`, `5xx`, network failure, or timeout — return a sanitized backoff response and do not call AIHOT.
5. Only after these checks may `/latest` fetch AIHOT.

The 10-second cooldown is best-effort duplicate protection, not the primary security boundary. The high-entropy access key is the primary authorization boundary.

#### Fresh AIHOT path

For an accepted call:

1. Fetch the current AIHOT Codex Reset snapshot without relying on automatic delivery state.
2. Validate the snapshot using the same schema and safety rules as the automatic path.
3. Traverse every event and source post.
4. Select the globally newest source post by `posts[].publishedAt`; never use `events[0]` as a latest-post shortcut.
5. Build the same source-post canonical notification model used by automatic signals.
6. Send it once to every currently configured target using the same bounded target-stream concurrency limit.
7. Return sanitized per-channel/target results.
8. Do not create automatic signals, modify automatic delivery keys, or advance the automatic ETag/watermark.

A manual `/latest` call therefore does not suppress a later automatic notification for the same real source post.

#### Response/privacy headers

All `/latest` responses must include at least:

```text
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Robots-Tag: noindex, nofollow
```

The project documentation must warn that the authenticated bookmark contains a secret in its URL and should not be shared, pasted into public issue reports, or used on untrusted devices. Browser history or sync systems may retain the full URL; users who suspect disclosure should rotate `LATEST_ACCESS_KEY` immediately.

### Unknown routes

Return `404`.

## 16. Migration to V4

Existing deployments may contain earlier monolithic state formats.

V3 and earlier did not persist the complete immutable notification payload, target snapshot, and per-target delivery state required by V4. Therefore V1 chooses an explicit **baseline migration**, not a lossy guess at in-flight retry reconstruction.

When `stateVersion !== 4` or no valid V4 commit exists:

1. Do not trust an incompatible old ETag.
2. Fetch and fully validate a complete AIHOT snapshot.
3. Build the boundary watermark from all current source posts.
4. Treat currently anchored receipt-review confirmations as baseline-known without sending notifications.
5. Do not create historical source-post or receipt-review delivery work.
6. Commit `meta:v4` only after baseline preparation succeeds.
7. Record migration diagnostics as `migrated`.
8. If legacy state indicates old pending/in-flight delivery intent that cannot be represented losslessly as a V4 immutable signal plus target snapshot, **intentionally abandon that legacy retry intent** and record a sanitized `legacy_pending_abandoned` diagnostic.

The migration policy prioritizes avoiding historical floods and malformed retry reconstruction over preserving incomplete legacy retry intent. README upgrade notes must state this explicitly and recommend invoking authenticated `/latest` once after upgrade to verify the complete AIHOT → Worker → notification path.

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
- current source backoff deadline and consecutive failure count when applicable;
- latest committed source time;
- number of active targets;
- pending/retry/permanent-failure counts;
- receipt-review anchoring/correction warnings;
- migration warnings such as `legacy_pending_abandoned`;
- multi-target configuration errors without secret values;
- last successful notification time;
- sanitized last errors.

Never persist full secrets in logs, KV values, errors, or HTTP responses.

For `/latest`, logs and diagnostics may record only sanitized facts such as route name, authentication success/failure category, speculative-request rejection, cooldown/backoff category, and aggregate delivery result. They must not include the access key, raw query string, or full request URL.

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
- receipt-review anchor selects the earliest valid source post by `(publishedAt, post.id)`;
- receipt-review signal ID is exactly `receipt_review:<event.type>:<anchorPostId>`;
- receipt-review regrouping with overlapping source-post IDs does not create a duplicate signal;
- unanchored receipt-review produces diagnostics but no automatic notification;
- receipt-review payload has `observedAt`, `sourceUrl: null`, and does not invent `publishedAt`.

### Commit-protocol tests

Mandatory tests:

- new signal payload is persisted before `meta:v4` advances;
- signal persistence failure leaves old ETag/watermark committed;
- partially persisted stable signals are deduplicated on the next full fetch;
- `304` still allows pending delivery from persisted canonical payload;
- no code path requires two rapid writes to one monolithic state key;
- send succeeds externally but persisting `sent` fails: the next execution still treats the target as undelivered/retryable, demonstrating at-least-once rather than exactly-once semantics;
- two overlapping source executions starting from the same stale `W0` and committing in opposite order do not permanently lose source-post signals; a later full snapshot converges using stable signal IDs and immutable signal records.

### Source-backoff tests

Mandatory tests:

- `429` with `Retry-After` blocks Cron and `/latest` until the deadline;
- `503` with `Retry-After` is handled the same way;
- `5xx` without `Retry-After` advances deterministic exponential source backoff;
- network failure and timeout advance source backoff;
- `200` and `304` reset the consecutive source-failure counter.

### Target-configuration tests

Mandatory tests:

- webhook semicolon lists trim whitespace and reject empty elements;
- `%3B` remains part of a target value rather than becoming a separator;
- Telegram token/chat list cardinality must match exactly;
- ntfy one-server/one-token values broadcast across multiple topics;
- ntfy N servers/tokens pair by index with N topics;
- ntfy any other cardinality produces a sanitized configuration error;
- configuration diagnostics never contain raw webhook URLs, bot tokens, or target hashes.

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
- source polling is not starved by backlog;
- once `sent` is durably recorded and visible, the relay does not intentionally resend that signal/target pair;
- no more than 3 target streams execute concurrently;
- signals for the same target are attempted serially in `(sortAt, signalId)` order;
- a slow target does not prevent other target streams from using available concurrency slots.

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
- `HEAD /latest` never performs external requests;
- prefetch/prerender `/latest` never performs external requests;
- `/latest` without a key returns `403` before any external request;
- `/latest` with a wrong key returns `403` before any external request;
- authenticated `/latest` checks the 10-second cooldown before AIHOT;
- authenticated `/latest` obeys all active `source:backoff` before AIHOT;
- accepted `/latest` performs a fresh AIHOT fetch;
- `/latest` selects the real newest source post by `publishedAt`;
- `/latest` sends the fresh result to currently configured targets;
- `/latest` uses at most 3 concurrent target streams;
- `/latest` does not mutate automatic signal/delivery or source-commit state;
- `/latest` responses include `no-store`, `no-referrer`, and `noindex` protections;
- logs never contain the raw access key or complete query URL;
- unknown routes return 404.

### Migration tests

Mandatory tests:

- V3→V4 migration never replays historical notifications;
- incompatible old ETag is not reused;
- legacy retry intent that cannot be represented losslessly is abandoned explicitly and emits `legacy_pending_abandoned` diagnostics;
- post-migration `/latest` can still verify the full path independently of automatic delivery state.

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
- Exact multi-target list/cardinality rules, including Telegram and ntfy examples.
- Cron configuration.
- `LATEST_ACCESS_KEY` generation and Cloudflare Secret configuration.
- A mobile-friendly `/latest?key=...` bookmark example.
- Explicit warning that the bookmarked URL itself contains a secret and must not be shared.
- Access-key rotation guidance.
- Explanation that HEAD/prefetch/prerender requests do not execute `/latest` side effects.
- V3→V4 upgrade note explaining that incomplete legacy pending retries are intentionally abandoned rather than guessed.
- At-least-once delivery semantics, including crash-window and stale-KV overlapping-execution duplicates.
- Bounded concurrency behavior: at most 3 target streams, same-target signals serialized.
- Troubleshooting/FAQ.
- AIHOT attribution and API/data-usage statement.
- Security guidance: never commit real webhook URLs, bot tokens, `.env`, `.dev.vars`, or `LATEST_ACCESS_KEY`.

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
- `/latest` always requires a high-entropy `LATEST_ACCESS_KEY`; there is no unauthenticated mode.
- `HEAD`, prefetch, and prerender requests to `/latest` must never cause side effects.
- Real `/latest` GET requests validate authorization, cooldown, and source backoff before any AIHOT or notification fetch.
- `/latest` never logs the raw query string, complete request URL, or access key.
- `/latest` responses are non-cacheable and suppress referrer leakage.
- Source backoff created by `Retry-After`, `5xx`, network failure, or timeout is checked before every AIHOT fetch, including manual `/latest`.
- Multi-target configuration errors must fail closed for the affected channel and must not echo credential-bearing values.
- Outbound notification concurrency is bounded to 3 target streams per invocation.

## 23. Success criteria for V1

V1 is complete when:

1. A durable new AIHOT Codex source-post signal is eventually delivered at least once to each eligible active target unless that target reaches a documented terminal failure; after `sent` is durably recorded and visible, that signal/target pair is not intentionally resent.
2. The documentation explicitly acknowledges both known duplicate windows: crash-before-ack persistence and overlapping execution with stale KV reads.
3. Multiple new posts in one snapshot are all classified against the same immutable W0 and none are lost because of iteration order.
4. Same-timestamp source posts are deduplicated by the boundary ID set even after old signal pruning.
5. An anchored `receipt_review` confirmation without a new confirmation source post can produce one stable signal, while unanchored receipt reviews are diagnosed and not guessed.
6. Receipt-review regrouping with overlapping source-post anchors does not create duplicate confirmation notifications.
7. Historical AIHOT backfills do not create false fresh alerts.
8. Newly detected signals with complete canonical payloads are durable before ETag/watermark advances.
9. AIHOT `304` responses do not prevent pending delivery retries.
10. Partial target failures do not intentionally resend targets already durably marked `sent` and visible to the executing location.
11. Retryable target failures back off; invalid credentials do not retry forever.
12. Source `429`, `503`, other `5xx`, network errors, and timeouts establish deterministic backoff that Cron and `/latest` both obey.
13. Notification backlog cannot starve source monitoring.
14. Removed/re-added targets do not receive unintended historical replay.
15. Multi-target configuration has deterministic parsing/cardinality rules for every V1 channel family, and invalid cardinality fails safely.
16. No Worker invocation uses more than 3 concurrent target streams, while signals for one target preserve local chronological ordering.
17. External text cannot inject platform markup, mass mentions, unsafe URLs, or malformed Generic Webhook JSON.
18. No public HTTP route exposes credentials or target secret hashes.
19. A bookmarked authenticated `GET /latest` provides a one-tap mobile full-path test while unauthenticated, HEAD, prefetch, and prerender requests cannot trigger AIHOT or notification traffic.
20. `/latest` respects accidental-repeat cooldown and all source backoff before fetching AIHOT.
21. V3→V4 migration does not replay history and explicitly abandons unreconstructable legacy pending work rather than silently guessing.
22. Overlapping/stale-KV execution tests demonstrate eventual convergence without permanent loss of source-post signals.
23. README clearly credits AIHOT and explains the independent code-license/API-use boundary.

## 24. Future extensions

Potential future work, not required for V1:

- Email delivery.
- Additional adapters such as Gotify or PushDeer.
- Optional Cloudflare Workers Rate Limiting binding for operator routes.
- Optional Cloudflare Access recipes for stronger browser-authenticated operator access.
- Optional time-limited HMAC or TOTP operator links for users who prefer stronger rotating credentials over one-tap bookmarks.
- Durable Objects only if future features require strict coordination, distributed exactly-once-style guarantees, or transactional counters.
- Optional GitHub-to-Cloudflare automatic deployment.
- Richer operational dashboard.

These extensions must not weaken AIHOT attribution, API-use compliance, source commit invariants, secret isolation, or the per-target delivery-state model.
