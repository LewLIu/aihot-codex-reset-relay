# AIHOT Codex Reset Relay — Design Specification

Date: 2026-09-16
Status: **Approved — implementation ready**
Repository: `LewLIu/aihot-codex-reset-relay`

## 1. Purpose

AIHOT Codex Reset Relay is a self-hosted Cloudflare Workers project that monitors AIHOT's public Codex Reset API and relays new Codex reset information to user-configured notification channels.

The project does **not** scrape X/Twitter, independently decide whether a reset happened, mirror AIHOT's API, or provide hosted SaaS. AIHOT is the upstream structured-data source; this project is responsible for polling, validation, state tracking, deduplication, retryable delivery, and channel-specific formatting.

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
- Respect AIHOT `Retry-After` and exponential source backoff.
- Detect source posts using stable `posts[].id`.
- Use `posts[].publishedAt` as source chronology.
- Detect anchored `receipt_review` confirmations even without a new confirmation post.
- Suppress historical backfills/regrouped old posts.
- Persist immutable signals and per-target delivery outcomes in Workers KV.
- Retry retryable failures with bounded attempts, backoff, and per-run budget.
- Provide authenticated, mobile-friendly `GET /latest` that performs a fresh AIHOT fetch and sends the real latest source post.
- Support multiple targets per notification channel.
- Bound outbound concurrency while preserving per-target signal ordering.
- Expose sanitized status and health endpoints.
- Provide automated tests and GitHub Actions CI.

### Out of scope for V1

- X/Twitter scraping.
- Independent reset truth determination.
- AIHOT API proxy/mirror or bulk history redistribution.
- Hosted SaaS, user accounts, admin UI.
- Databases other than Workers KV.
- Durable Objects.
- Email delivery.
- Automatic Cloudflare deployment from GitHub Actions.
- Unauthenticated side-effecting routes.
- Distributed exactly-once delivery guarantees.

## 3. AIHOT attribution, API rules, and licensing boundary

Repository code uses the **MIT License**. MIT covers only code authored for this repository; it does not grant rights to AIHOT APIs/data/content or third-party source content.

README documentation MUST state that this is an independent community project, not an official AIHOT project; credit AIHOT for Codex Reset aggregation, structuring, translations, and public API; and explain that users remain responsible for AIHOT's current API/data-use rules. Attribution does not itself grant commercial or redistribution permission.

The client MUST behave respectfully:

- default polling interval: 30 minutes;
- conditional GET via ETag;
- no aggressive retry loops;
- any valid `Retry-After` establishes source backoff shared by Cron and `/latest`;
- `429` uses `Retry-After` when present;
- `503`/other upstream failures use `Retry-After` when present, otherwise deterministic exponential backoff;
- successful `200` or `304` resets the consecutive source-failure counter;
- schema, parsing, validation, or pre-commit persistence failure MUST NOT advance source commit state.

## 4. AIHOT API semantics

V1 expects `schemaVersion === 1`.

Top-level fields used: `schemaVersion`, `timezone`, `checkedAt`, `historyFrom`, `count`, `events`.

Important event fields: `id`, `type`, `label`, `status`, `title`, `scope`, `createdAt`, `updatedAt`, `confirmedAt`, `occurredOn`, `confirmationBasis`, `schedule`, `posts`, `url`.

Important post fields: `id`, `publishedAt`, `stage`, `text`, `originalText`, `url`.

Normative rules:

- `events[0]` MUST NOT be treated as the newest source message; events are ordered by `event.updatedAt`.
- Global latest source post is selected by comparing every `posts[].publishedAt` across all events.
- `event.id` is not assumed to remain the same logical identity across every future regrouping/correction.
- `post.id` is the stable identity used for source-post dedupe and receipt anchoring.

## 5. Architecture and repository structure

Use a lightweight modular Adapter architecture:

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

Expected source layout:

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

Supporting files: `test/`, `wrangler.jsonc`, `package.json`, `.gitignore`, `README.md`, `README_EN.md`, `LICENSE`.

## 6. Workers KV persistence model

Do **not** store the whole application state in one frequently rewritten JSON key. V1 uses separate keys with one responsibility each.

### `meta:v4`

Committed source snapshot boundary:

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

It is written only after all newly detected signals for the validated snapshot are durably persisted.

### `signal:<signalId>`

Immutable durable work item containing complete canonical notification payload and the target snapshot active at discovery time.

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
  "targetIds": ["wework:<hash>", "telegram:<hash>"]
}
```

Receipt-review signals additionally persist `anchorPostId` and `receiptAnchorPostIds`.

### `delivery:<signalId>:<targetId>`

**Missing key means pending/not yet attempted.** Existing statuses:

- `sent`
- `retry_wait`
- `permanent_failure`
- `disabled`

Retry example:

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

### `target:<targetId>`

Non-secret lifecycle metadata only:

```json
{
  "channel": "wework",
  "status": "active",
  "enabledAt": "...",
  "disabledAt": null
}
```

### `source:backoff`

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

- checked before **every** AIHOT fetch, including `/latest`;
- valid `Retry-After` directly sets `retryNotBefore`;
- without it: `5m → 10m → 20m → 40m → 80m → 160m → 320m → 6h`, capped at 6h;
- successful `200`/`304` resets consecutive source failures.

### `manual:latest`

Best-effort accidental-repeat protection:

```json
{ "lastAcceptedAt": "..." }
```

It is not authentication. `/latest` checks it after authentication and before AIHOT; calls within 10 seconds are rejected without external requests.

### `diag:last`

Sanitized operational diagnostics only. No secrets.

### No hot pending index

V1 does not maintain `pending:index`. Low event volume permits paginated `KV.list({ prefix: "signal:" })` during later-run recovery/retry. Newly created in-memory signals are dispatched directly after commit; the same invocation MUST NOT rely on KV listing immediately reflecting its writes.

### Physical KV write invariants

These are implementation requirements, not suggestions:

1. `signal:*` records are immutable and are written at most once for a logical signal.
2. A `delivery:*` key MUST NOT be pre-created merely to represent `pending`; missing delivery key is the pending state.
3. After an external delivery attempt finishes, create/update only that signal-target pair's `delivery:*` key with `sent`, `retry_wait`, `permanent_failure`, or `disabled`.
4. Retry updates to an existing `delivery:*` key occur only after `nextAttemptAt` is eligible; retry intervals are minutes/hours, never sub-second.
5. `meta:v4` is committed at most once for one accepted source snapshot.
6. `diag:last` is written once at the end of one invocation.
7. `target:*`, `source:backoff`, and `manual:latest` are independent keys; no implementation may collapse them with `meta`, `signal`, or `delivery` into one frequently rewritten shared state key.
8. The implementation MUST NOT add artificial `sleep(1000)` delays to work around KV same-key write limits; key separation is the required solution.
9. Per-target outcome persistence MUST NOT be implemented as repeated rewrites of a shared aggregate state object.

### Eventual consistency boundary

Workers KV is eventually consistent across locations. V1 does not use KV as a distributed lock or claim exactly-once coordination.

Consequences:

- stable immutable signal IDs provide logical dedupe;
- overlapping executions may briefly read stale delivery state and duplicate a send;
- another location may briefly observe stale `meta:v4`;
- later full-snapshot processing MUST converge without silently losing source posts.

Durable Objects remain out of scope because V1 accepts this rare duplicate window.

## 7. Signal model

### Source-post signal

```text
post:<post.id>
```

### Receipt-review signal

Candidate condition:

```text
event.status == "confirmed"
&& event.confirmationBasis == "receipt_review"
```

Exact anchor algorithm:

1. collect event posts with valid `post.id` and `publishedAt`;
2. sort by `(publishedAt, post.id)` ascending;
3. first post becomes `anchorPostId`;
4. signal ID is `receipt_review:<event.type>:<anchorPostId>`;
5. persist all current source-post IDs as `receiptAnchorPostIds`.

Before creating a new receipt signal, inspect existing receipt signals of the same `event.type`; source-post-ID overlap means the same logical receipt confirmation and MUST NOT emit a duplicate even if regrouping changes the canonical first post.

If no valid source post exists, V1 does not guess an identity. Record `unanchored_receipt_review` and do not notify until a usable anchor appears or the upstream contract improves.

Previously sent receipt notifications are not retracted. A later regrouped confirmation with overlapping anchor posts is not resent. If all overlap disappears, V1 cannot prove continuity; apply the normal anchor algorithm and emit sanitized correction/regrouping diagnostics when detectable.

Receipt payload is a distinct shape:

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

Do not invent `publishedAt` for receipt signals.

### Source-post canonical notification

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

Canonical data is plain structured text, not platform Markdown/HTML. Automatic signals persist the complete payload before dispatch. `/latest` builds the same source-post payload from its fresh snapshot but does not mutate automatic state.

## 8. Snapshot validation and watermark algorithm

For every AIHOT `200`:

1. validate `schemaVersion`;
2. validate required collection shapes;
3. validate timestamps used by ordering/watermark logic;
4. detect duplicate `post.id` with conflicting data;
5. reject the snapshot if required invariants fail.

Validation failure MUST NOT advance ETag/watermark.

### Boundary watermark

```json
{
  "publishedAt": "T",
  "postIdsAtPublishedAt": ["id-a", "id-b"]
}
```

For unseen source post relative to immutable entry watermark `W0=(T0, IDs0)`:

- `publishedAt < T0` → historical, no notification;
- `publishedAt > T0` → new candidate;
- `publishedAt == T0` and ID not in `IDs0` → new candidate;
- same timestamp and ID already in `IDs0` → known boundary post.

Every post in one snapshot is classified against the **same W0**. Never advance watermark inside the traversal.

After classification and durable signal persistence, construct `W1` from the maximum valid `publishedAt` in the accepted snapshot; `postIdsAtPublishedAt` contains every known post ID at exactly that timestamp.

## 9. Source commit protocol

For automatic AIHOT `200`:

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
persist per-target outcomes
```

Normative rules:

- validation failure → no `meta:v4` update;
- any required signal-write failure before commit → no `meta:v4` update;
- partially written signals are safe because later processing dedupes by stable signal IDs/receipt-overlap rules;
- incompatible schema or pre-commit failure MUST NOT save new ETag;
- only final `meta:v4` write commits the accepted source boundary;
- later `304` is safe because retry payloads already live in `signal:*`;
- `/latest` does not advance ETag, watermark, signals, or automatic delivery records.

The protocol is crash-recoverable rather than transactional. Overlapping source executions may observe stale `meta:v4` or temporarily regress metadata; stable immutable signals and later full snapshots MUST converge without permanent source-post loss.

## 10. Signal ordering

New signals in one snapshot are scheduled by `(sortAt, signalId)` ascending.

- source post: `sortAt = post.publishedAt`
- receipt review: `sortAt = event.confirmedAt || event.updatedAt || snapshot.checkedAt`

Per-target ordering is best-effort across separate invocations; V1 guarantees deterministic scheduling inside one invocation, not globally transactional external-platform ordering.

## 11. Target model and configuration

Supported V1 channels: WeCom, Feishu, DingTalk, Telegram, Bark, ntfy, Slack, Generic Webhook. Email is excluded.

Configuration names:

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

`LATEST_ACCESS_KEY` is mandatory for `/latest`, stored as a Cloudflare Secret, and SHOULD contain at least 256 random bits encoded URL-safely.

### Multi-target contract

Semicolon-list rules:

1. literal `;` separates entries;
2. semicolon inside a URL/value must be percent-encoded as `%3B`;
3. trim surrounding whitespace;
4. empty elements are invalid;
5. config errors are sanitized and never echo secret values.

Webhook channels use one target per URL entry. `WEWORK_MSG_TYPE` is a single global WeCom rendering mode in V1.

Telegram uses positional pairing:

```text
TELEGRAM_BOT_TOKEN=token1;token2
TELEGRAM_CHAT_ID=chat1;chat2
```

Lengths MUST match exactly and be non-zero.

ntfy uses `NTFY_TOPIC` as target-count authority. For N topics:

- server omitted → `https://ntfy.sh` for all;
- one server → broadcast to all N;
- N servers → pair by index;
- any other count → config error;
- token omitted → unauthenticated;
- one token → broadcast to all N;
- N tokens → pair by index;
- any other count → config error.

Expanded target config is deterministic before hashing.

### Target identity

Canonicalize relevant target config, SHA-256 it, and use the first 128 bits (32 lowercase hex chars) as target hash. Raw secrets MUST NOT appear in KV keys, logs, status, or responses.

### Target lifecycle

- first configured → `target:<targetId>` active;
- removed/rotated target → target disabled, old pending/retry deliveries become `disabled` when encountered, excluded from retry/health pending counts;
- re-enabled identical target receives only future signals after reactivation;
- credential change changes target hash and creates a new identity;
- new targets never receive historical signals merely because they were added.

## 12. Delivery semantics and retry policy

V1 is **at-least-once**, not exactly-once.

> A durable signal is eventually delivered at least once to each eligible target, subject to retry limits and terminal failures. After `sent` is durably recorded and visible to the executing location, the relay does not intentionally resend that signal-target pair.

Known duplicate windows:

1. external platform accepts the message but Worker crashes before persisting `sent`;
2. overlapping execution at another location temporarily reads stale KV and does not see a new `sent` record.

### Retryable failures

Network error, timeout, HTTP `408`, `429`, `5xx`, and documented platform rate-limit errors are retryable unless platform semantics say otherwise.

Use platform `Retry-After` when available; otherwise delivery backoff is:

```text
30m → 1h → 2h → 4h → 8h → 16h → 24h → 24h
```

After 8 failed retryable attempts, mark `permanent_failure`.

Typical invalid configuration/credential responses (`400`, `401`, `403`, `404`, `410`) are terminal subject to platform-specific semantics.

All outbound AIHOT/channel requests have a finite timeout; V1 default is 10 seconds.

### Per-run budget and concurrency

- source monitoring has priority over delivery backlog;
- maximum 10 notification attempts per Cron invocation;
- maximum **3 concurrent target streams**;
- one target stream is one `targetId`;
- signals inside a target stream run strictly serially in `(sortAt, signalId)` order;
- different target streams may run concurrently up to 3;
- no unbounded `Promise.allSettled()` over all deliveries;
- `/latest` contains one notification and may send to at most 3 targets concurrently until every configured target has one result.

## 13. Cron execution flow

Schedule:

```text
*/30 * * * *
```

Flow:

1. load `meta:v4` and target config;
2. reconcile target lifecycle;
3. check `source:backoff`;
4. if eligible, perform AIHOT conditional request;
5. handle upstream:
   - `304` → reset source failure count; no source commit;
   - `200` → validate, classify against W0, persist signals, commit `meta:v4`, reset source failures;
   - `429` → persist backoff using `Retry-After` if present;
   - `503`/other `5xx` → use `Retry-After`, otherwise exponential source backoff;
   - network/timeout → exponential source backoff;
   - incompatible/invalid snapshot → preserve source state, no ETag/watermark advance;
6. build eligible work from new signals + durable retry backlog;
7. group by target, preserving `(sortAt, signalId)`;
8. dispatch at most 3 target streams concurrently, max 10 attempts total, respecting `nextAttemptAt`;
9. persist per-target results;
10. write `diag:last` once.

Backlog MUST NOT prevent the source check from running.

## 14. Notification adapters and untrusted-content boundary

AIHOT-returned title/text/translation/original text/URLs are untrusted external data.

Every adapter MUST:

- escape platform markup as needed;
- neutralize upstream mass mentions such as `@channel`, `@here`, `@everyone`, `@all` and platform equivalents;
- allow only `http:`/`https:` source links;
- truncate overlong descriptive content while retaining critical metadata/links;
- validate both HTTP status and platform business-success fields;
- never interpolate raw upstream content into executable JSON text.

Generic Webhook template MUST be parsed as structured JSON; placeholder substitution occurs only in string values before final `JSON.stringify()`.

## 15. HTTP routes

### `GET /`

Public sanitized status: service/version, AIHOT attribution/source, schedule, last committed source check, AIHOT `checkedAt`, latest source-post time, last Cron status, target counts, pending/retry/permanent-failure counts. Never return credentials, raw target hashes, or secret-bearing config.

### `GET /health`

Minimal sanitized read-only health response.

### `GET /latest`

Mobile-friendly full-path operator test:

```text
AIHOT → Worker validation → global latest post → adapters → configured targets
```

Invocation:

```text
GET /latest?key=<LATEST_ACCESS_KEY>
```

No-side-effect guards, before authentication/external work:

- `HEAD /latest` → `405 Method Not Allowed`, `Allow: GET`, no external request;
- `Sec-Purpose`/legacy `Purpose` indicating `prefetch` or `prerender` → sanitized `204` (or equivalent), no side effects.

For real GET:

1. validate key before target reads or any external request;
2. missing/wrong key → immediate `403`;
3. never log access key, raw query string, or full request URL;
4. check `manual:latest` 10-second cooldown;
5. check all active `source:backoff`;
6. only then fetch AIHOT;
7. validate full snapshot;
8. traverse every event/post and select max `posts[].publishedAt`;
9. build normal source-post canonical notification;
10. send once to every currently configured target with max concurrency 3;
11. return sanitized per-target results;
12. do not mutate automatic signals/deliveries/ETag/watermark.

Responses include:

```text
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Robots-Tag: noindex, nofollow
```

The bookmarked URL itself is a secret capability and MUST NOT be shared. Suspected disclosure requires rotating `LATEST_ACCESS_KEY`.

Unknown routes return `404`.

## 16. Migration to V4

V3 and earlier lack the immutable payload/target snapshot/per-target state needed for lossless V4 retry reconstruction. Migration is therefore a **baseline migration**:

1. ignore old incompatible ETag;
2. fetch/validate full AIHOT snapshot;
3. build boundary watermark from current posts;
4. treat currently anchored receipt confirmations as known without sending;
5. create no historical delivery work;
6. commit V4 only after baseline succeeds;
7. record `migrated` diagnostics;
8. if old pending/in-flight work cannot be represented losslessly, intentionally abandon it and record `legacy_pending_abandoned`.

README upgrade notes MUST explain this and recommend one authenticated `/latest` call after upgrade to verify the complete path.

## 17. Retention and cleanup

Retain completed signal state for approximately 90 days.

A signal is prunable only when every target is terminal: `sent`, `permanent_failure`, or `disabled`. `retry_wait` and missing delivery records are never pruned solely by age. Prune associated delivery keys with the signal.

Boundary watermark is independent of signal retention; pruning MUST NOT resurrect an already-known boundary post.

## 18. Error handling and observability

Store only sanitized diagnostics:

- Cron start/end;
- source result/status and active backoff deadline/failure count;
- latest committed source time;
- active target counts;
- pending/retry/permanent-failure counts;
- receipt anchoring/correction warnings;
- `legacy_pending_abandoned`;
- sanitized multi-target config errors;
- last successful notification time;
- sanitized last errors.

`/latest` logs may record only route, auth result category, speculative-request rejection, cooldown/backoff category, and aggregate delivery result; never key/query/full URL.

## 19. Testing strategy

Use Vitest. Mandatory regression coverage includes:

### AIHOT / watermark / receipt

- global latest selected by `publishedAt`, not `events[0]`;
- two new posts in one snapshot discovered regardless of traversal order;
- same-timestamp unseen ID discovered;
- same-timestamp boundary ID not rediscovered after old signal pruning;
- historical `< watermark` suppressed;
- conflicting duplicate `post.id` invalidates snapshot;
- incompatible schema does not advance source state;
- receipt anchor chooses earliest `(publishedAt, post.id)`;
- receipt signal ID formula is exact;
- regrouping with overlapping source posts does not duplicate;
- unanchored receipt produces diagnostics/no automatic notification;
- receipt payload uses `observedAt`, `sourceUrl:null`, no invented `publishedAt`.

### KV / commit protocol

- signal payload persists before `meta:v4` advances;
- signal-write failure leaves old ETag/watermark;
- partially persisted stable signals dedupe on later full fetch;
- `304` still permits pending delivery from persisted payload;
- implementation never uses a monolithic hot state key;
- missing delivery key represents pending; no pending pre-write occurs;
- one accepted snapshot writes `meta:v4` at most once;
- `diag:last` is written once per invocation;
- external send succeeds but `sent` persistence fails → later execution remains retryable (at-least-once semantics);
- two overlapping source executions from stale W0/commit reversal later converge without permanent signal loss.

### Source backoff

- `429` + `Retry-After` blocks Cron and `/latest`;
- `503` + `Retry-After` behaves the same;
- other `5xx`/network/timeout advance deterministic backoff;
- `200`/`304` reset consecutive failure count.

### Target configuration

- semicolon lists trim whitespace/reject empties;
- `%3B` remains inside value;
- Telegram token/chat cardinality matches exactly;
- ntfy single server/token broadcasts to N topics;
- ntfy N-value lists pair by index;
- other ntfy cardinality fails safely;
- diagnostics never expose raw secrets/hashes.

### Delivery

- partial success retries only failed target;
- invalid credential becomes terminal where applicable;
- target `429` respects retry timing;
- exponential backoff and 8-attempt terminal transition;
- removed/re-enabled target behavior;
- max 10 attempts/run;
- source poll not starved by backlog;
- `sent` visible → no intentional resend;
- max 3 target streams concurrently;
- same target signals serialize by `(sortAt, signalId)`;
- slow target does not occupy all progress.

### Adapter safety

Mock `fetch()` for all eight adapters; verify payloads, success/failure normalization, business-error-on-HTTP-200 handling, markup escaping, mass-mention neutralization, URL filtering, and Generic Webhook structured substitution.

### Routes

- `/` and `/health` never leak secrets/hashes;
- `HEAD`, prefetch, prerender `/latest` have no side effects;
- missing/wrong key returns `403` before external requests;
- authenticated `/latest` checks cooldown/backoff before AIHOT;
- accepted `/latest` performs fresh AIHOT fetch;
- global newest post selected correctly;
- max 3 target concurrency;
- automatic state not mutated;
- privacy/cache headers present;
- logs omit key/full URL.

### Migration

- V3→V4 never replays history;
- old ETag not reused;
- unreconstructable old pending work explicitly abandoned/diagnosed;
- post-migration `/latest` verifies full path independently.

## 20. CI

GitHub Actions runs `npm test` and `npm run lint` for pushes to `main` and pull requests. No Cloudflare API token or automatic deploy is required in V1.

## 21. Documentation requirements

Provide Chinese `README.md` and English `README_EN.md` covering:

- Cloudflare Workers quick start and KV binding `CODEX_RESET_STATE`;
- channel secret configuration and exact multi-target/cardinality rules;
- Cron schedule;
- `LATEST_ACCESS_KEY` generation, secret storage, bookmark example, rotation, and URL-secret warning;
- HEAD/prefetch/prerender behavior;
- V3→V4 migration limitations;
- at-least-once semantics and duplicate windows;
- bounded concurrency behavior;
- troubleshooting/FAQ;
- AIHOT attribution/API-data-use boundary;
- security guidance for `.env`, `.dev.vars`, webhook URLs, bot tokens, and access keys.

README MUST describe this as an independent community project, not an official AIHOT product.

## 22. Security requirements

- credentials live in Cloudflare Secrets or ignored local env files;
- ignore `.env*`, `.dev.vars*`, `.wrangler/`, dependency/build artifacts;
- never expose secrets through status routes/logs/KV keys;
- target IDs use at least 128 bits of SHA-256 output;
- upstream text is untrusted and safely rendered;
- invalid multi-target config fails closed for the affected channel;
- `/latest` always requires high-entropy key, has no unauthenticated mode, and performs guards/auth/cooldown/backoff before external work;
- outbound notification concurrency is at most 3 target streams;
- source backoff applies to every AIHOT fetch.

## 23. Success criteria for V1

V1 is complete when:

1. Durable source-post signals are eventually delivered at least once to each eligible target unless terminal failure occurs; after visible durable `sent`, no intentional resend occurs.
2. Crash-before-ack and stale-KV overlap duplicate windows are documented.
3. Multiple/new same-timestamp posts are handled without traversal-order loss.
4. Anchored receipt review produces one stable signal; unanchored receipt is diagnosed, not guessed.
5. Receipt regrouping with overlapping source anchors does not duplicate.
6. Historical backfills do not create fresh alerts.
7. Complete immutable signal payloads are durable before ETag/watermark advance.
8. `304` does not block pending retries.
9. Partial target failures do not intentionally resend visible `sent` targets.
10. Retryable target failures back off and invalid credentials do not retry forever.
11. Source `429`, `503`, other `5xx`, network, and timeout backoff is deterministic and shared by Cron/`/latest`.
12. Backlog cannot starve source monitoring.
13. Removed/re-added targets do not receive unintended historical replay.
14. Multi-target parsing/cardinality is deterministic and invalid config fails safely.
15. No invocation exceeds 3 target streams; same-target chronological order is preserved locally.
16. Upstream content cannot inject mass mentions, unsafe markup/URLs, or malformed Generic Webhook JSON.
17. No public HTTP route exposes credentials or target hashes.
18. Authenticated bookmarked `GET /latest` provides one-tap full-path testing while unauthenticated/speculative requests cannot cause side effects.
19. `/latest` respects cooldown and all source backoff before AIHOT.
20. V3→V4 does not replay history and explicitly abandons unreconstructable old pending work.
21. Overlapping/stale-KV tests demonstrate eventual convergence without permanent source-post loss.
22. Physical KV writes obey the key-level invariants in §6; no monolithic hot-state workaround exists.
23. README clearly credits AIHOT and explains licensing/API-use boundaries.

## 24. Future extensions

Not required for V1:

- Email.
- Gotify/PushDeer or additional adapters.
- Optional Workers Rate Limiting binding for operator routes.
- Optional Cloudflare Access recipes.
- Optional time-limited HMAC/TOTP operator links.
- Durable Objects only if future requirements demand strict coordination, distributed exactly-once-style guarantees, or transactional counters.
- Automatic GitHub→Cloudflare deployment.
- Richer operational dashboard.

Future changes MUST NOT weaken AIHOT attribution/compliance, source commit invariants, secret isolation, or per-target delivery state.
