# AIHOT Codex Reset Relay

[![CI](https://github.com/LewLIu/aihot-codex-reset-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/LewLIu/aihot-codex-reset-relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

**Turn AIHOT's Tibo / Codex reset monitoring into your own multi-channel notification relay.**

AIHOT Codex Reset Relay is a self-hosted Cloudflare Worker. By default it polls the AIHOT Codex Reset API every 30 minutes, detects new reset / reset-credit source posts and anchored receipt-review confirmations, then delivers them independently to WeCom, Feishu, DingTalk, Telegram, Bark, ntfy, Slack, or generic webhooks.

- No dedicated server
- No always-on local computer
- Cloudflare Workers + KV only
- 8 notification channel types
- Multiple targets per channel
- Deduplication, per-target retries, and target lifecycle handling
- A mobile-friendly `/latest` URL for full AIHOT → Worker → notification testing
- Upstream polling is decoupled from delivery retries, so a `304 Not Modified` response does not block local pending deliveries

[中文 README](README.md)

> [!IMPORTANT]
> This is an independent community project. It is **not an official AIHOT, OpenAI, or Codex project**. It does not scrape Tibo/X directly, independently decide whether a reset is true, or mirror AIHOT data. It consumes AIHOT's public Codex Reset data and focuses on reliable notification delivery.

---

## Why this project exists

Codex extra resets, broad resets, and reset-credit updates are often announced in public posts by Tibo. If you rely heavily on Codex, missing one of these updates can mean more than missing a social post: you may not realize capacity has reset and may fail to use an available quota window in time.

AIHOT already solves the difficult first layer: **monitoring, organizing, translating, verifying, and structuring the public information**.

This project solves the next layer:

> **How do we reliably deliver AIHOT's Codex Reset information to the places you actually watch?**

```text
Public posts from Tibo
        ↓
      AIHOT
 Codex Reset monitoring
        ↓
GET /api/v1/codex-resets
        ↓
AIHOT Codex Reset Relay
   Cloudflare Worker
        ↓
┌────────┬────────┬────────┬──────────┐
│ WeCom  │ Feishu │ DingTalk│ Telegram │
├────────┼────────┼────────┼──────────┤
│ Bark   │ ntfy   │ Slack  │ Webhook  │
└────────┴────────┴────────┴──────────┘
```

---

## About AIHOT — and why this project is grateful for it

[AIHOT](https://aihot.news/) is a public AI information and Agent-integration service. In addition to AI news, hot topics, and daily reports, AIHOT provides anonymous read-only integration paths such as Agent Skill, MCP, RSS, and REST API.

For this project, the most important AIHOT capability is its **Tibo Codex Reset monitor**.

AIHOT handles a substantial amount of work that this repository intentionally does not duplicate:

- continuously following public Codex reset-related posts from Tibo;
- separating broad resets from reset-credit / make-up-credit events;
- distinguishing announcements from confirmations instead of treating an estimate as a completed reset;
- converting timestamps to Beijing time;
- providing Chinese translations while preserving original-source links;
- organizing historical records into a reset calendar;
- exposing an anonymous, read-only REST API with no API key required;
- and publishing reset / reset-credit announcement and confirmation updates to its own group channels.

Useful AIHOT links:

- **Tibo Reset Monitor / Calendar**: <https://aihot.news/codex-reset>
- **Codex Reset API**: <https://aihot.news/api/v1/codex-resets>
- **Agent / API Integration**: <https://aihot.news/agent>
- **AIHOT Changelog**: <https://aihot.news/changelog>

The motivation behind AIHOT's original feature launch was simple: users should not have to keep refreshing social feeds just to avoid missing a Codex reset. That same idea is what motivates this relay.

**Special thanks to AIHOT for continuously curating the public information, producing Chinese translations, verifying event state, and keeping a public API available.** Without that structured upstream source, this project would either have to maintain a fragile X/Tibo scraping pipeline or fall back to much less reliable text monitoring.

The spirit of AIHOT's original launch message is worth keeping: **refresh less, catch more reset credits, and happy coding.**

> The MIT License in this repository covers this repository's code only. It does **not** license AIHOT API/data or third-party source content. Follow AIHOT's current API/data terms and the rules of the original content platforms for your own use case.

---

## Features

### Automatic monitoring

- Cloudflare Cron every **30 minutes** by default;
- AIHOT conditional requests using `ETag` / `If-None-Match`;
- no positional assumption such as treating `events[0]` as the latest source post;
- stable `post.id`-based source-post deduplication;
- anchored receipt-review confirmation handling;
- historical backfills are not mistaken for new notifications;
- first deployment and V3→V4 baseline migration do not flood channels with historical reset events.

### Reliable delivery

- independent delivery state for each configured target;
- one broken Telegram bot or webhook does not block healthy targets;
- only failed targets are retried;
- retry schedule: `30m → 1h → 2h → 4h → 8h → 16h → 24h`, up to 8 attempts;
- maximum 10 delivery attempts per Cron run;
- maximum 3 concurrent target streams;
- ordering is preserved within the same target;
- removed or rotated targets are disabled for old pending work instead of replaying historical notifications to a replacement target.

### Mobile-friendly `/latest`

Bookmark a private URL on your phone:

```text
https://YOUR_WORKER.workers.dev/latest?key=YOUR_256_BIT_RANDOM_KEY
```

A valid request performs a full-path check:

```text
verify access key
  ↓
check cooldown / upstream backoff
  ↓
fetch AIHOT now
  ↓
validate the full snapshot
  ↓
find the globally latest source post
  ↓
deliver it to all currently configured targets
```

This is intended to verify the complete **AIHOT → Worker → notification channel** path, not just one webhook.

Manual `/latest` sends do not mutate the automatic Cron signal/delivery/watermark/ETag state, so testing does not consume a future automatic notification.

---

## Supported notification channels

| Channel | Configuration | Notes |
|---|---|---|
| WeCom | `WEWORK_WEBHOOK_URL` | Markdown by default; optional `WEWORK_MSG_TYPE=text` |
| Feishu / Lark | `FEISHU_WEBHOOK_URL` | Webhook bot |
| DingTalk | `DINGTALK_WEBHOOK_URL` | Markdown robot |
| Telegram | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Multiple accounts paired by index |
| Bark | `BARK_URL` | Useful for iPhone / iPad push |
| ntfy | `NTFY_TOPIC` + optional `NTFY_SERVER_URL` / `NTFY_TOKEN` | Hosted or self-hosted ntfy |
| Slack | `SLACK_WEBHOOK_URL` | Incoming Webhook |
| Generic Webhook | `GENERIC_WEBHOOK_URL` + optional `GENERIC_WEBHOOK_TEMPLATE` | Other bots and automation tools |

Unset channels are skipped automatically.

---

## Quick start

### 1. Requirements

Recommended:

- a Cloudflare account;
- Node.js 22;
- at least one webhook / bot / push target;
- a random high-entropy access key for `/latest`.

Clone and install:

```bash
git clone https://github.com/LewLIu/aihot-codex-reset-relay.git
cd aihot-codex-reset-relay
npm ci
```

### 2. Sign in to Cloudflare

```bash
npx wrangler login
```

`wrangler.jsonc` already declares:

```text
Worker name: aihot-codex-reset-relay
KV binding: CODEX_RESET_STATE
Cron: */30 * * * *
```

### 3. Set the `/latest` access key

Use at least **256 bits of random entropy**:

```bash
npx wrangler secret put LATEST_ACCESS_KEY
```

Do not use a birthday, phone number, short password, or a short MD5-derived value.

### 4. Configure notification targets

Webhook URLs, bot tokens, chat IDs, and similar values should also be stored as Cloudflare Secrets, for example:

```bash
npx wrangler secret put WEWORK_WEBHOOK_URL
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put SLACK_WEBHOOK_URL
```

Only configure the channels you actually use.

### 5. Deploy

```bash
npx wrangler deploy
```

After deployment, check:

```text
GET /
GET /health
GET /latest?key=<YOUR_LATEST_ACCESS_KEY>
```

Then allow at least one real Cron execution and confirm the automatic source state advances normally.

---

## Multiple targets

Use `;` to configure multiple targets for one channel:

```text
TARGET_A;TARGET_B;TARGET_C
```

Rules:

- surrounding whitespace is trimmed;
- empty list elements are invalid;
- encode a literal semicolon inside a URL as `%3B`;
- the relay does not guess ambiguous pairings; cardinality mismatches are treated as configuration errors.

### Telegram

```text
TELEGRAM_BOT_TOKEN=token1;token2
TELEGRAM_CHAT_ID=chat1;chat2
```

Counts must match exactly and are paired by index.

### ntfy

`NTFY_TOPIC` defines the target count `N`:

```text
NTFY_TOPIC=topic-a;topic-b
```

`NTFY_SERVER_URL` and `NTFY_TOKEN` may be:

- absent: default server / no token;
- one value: broadcast to every topic;
- exactly N values: paired by index;
- any other count: configuration error.

---

## Generic Webhook templates

If only `GENERIC_WEBHOOK_URL` is configured, the relay sends a default JSON payload.

If `GENERIC_WEBHOOK_TEMPLATE` is configured, it must be valid JSON. The implementation **parses JSON first, then recursively substitutes string values** instead of concatenating upstream content into raw JSON text, which reduces escaping and injection risk.

---

## HTTP endpoints

### `GET /`

Returns public, sanitized operational status such as:

- service / version;
- last check time;
- AIHOT source status;
- watermark / source checked time;
- configured target count;
- pending delivery count;
- last Cron status.

It does not expose webhook URLs, bot tokens, chat IDs, target hashes, or the `/latest` secret.

### `GET /health`

Minimal health endpoint for uptime probes.

### `GET /latest?key=...`

Authenticated full-path manual test.

Security rules include:

- the correct `LATEST_ACCESS_KEY` is required;
- a bad key is rejected before any AIHOT request;
- `HEAD /latest` has no side effects;
- browser prefetch / prerender requests do not send notifications;
- the 10-second cooldown is checked before upstream fetch;
- active AIHOT `Retry-After` / source backoff cannot be bypassed;
- responses use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow`;
- `wrangler.jsonc` enables `observability.redact_query_string=true`, removing the `?key=...` query string from Workers Logs / Traces request URLs.

**The complete bookmark URL is a credential.** Rotate `LATEST_ACCESS_KEY` immediately if you suspect it has leaked.

---

## How it works

### Source-first Cron processing

Each Cron run checks AIHOT before spending its whole budget on old failed deliveries, so a backlog cannot indefinitely starve new reset information.

### Full snapshot validation

A `200` response is validated before new signals or metadata are accepted. If the snapshot schema is incompatible or unsafe to process:

- no new signal is generated;
- ETag / watermark are not advanced;
- already-persisted local pending deliveries can still be retried.

### Frozen watermark per snapshot

Detection uses one immutable `W0` for the complete snapshot and commits `W1` only after processing finishes.

The watermark also remembers the post IDs exactly on the timestamp boundary:

```json
{
  "publishedAt": "2026-09-12T08:09:00Z",
  "postIdsAtPublishedAt": ["..."]
}
```

This prevents silently losing two different posts that happen to share the same timestamp precision.

### Durable signal before metadata commit

A new immutable normalized notification and its target snapshot are persisted before the new ETag / watermark is committed.

That means a later AIHOT `304 Not Modified` does not erase the relay's knowledge of what still needs to be delivered.

### Physical KV layout

The implementation does not repeatedly overwrite one hot state blob:

```text
meta:v4
signal:<signalId>
delivery:<signalId>:<targetId>
target:<targetId>
source:backoff
manual:latest
diag:last
```

`signal:*` records are immutable work items.

A missing `delivery:*` record means **pending**. The relay does not pre-create a pending delivery record and then rewrite it milliseconds later as `sent`, avoiding an unnecessary same-key hot-write pattern in Workers KV.

---

## Delivery semantics

The relay provides **at-least-once** delivery, not distributed exactly-once.

After a successful delivery is durably recorded, the relay does not intentionally resend that signal to the same target. However, rare duplicate windows remain possible when:

1. the external webhook succeeds;
2. the Worker crashes before persisting the durable `sent` acknowledgement;
3. or an overlapping execution temporarily reads stale KV state.

The design intentionally prefers:

> **An occasional duplicate is better than silently dropping an important reset notification.**

---

## AIHOT upstream errors and backoff

- `304`: no new snapshot; local pending deliveries still run;
- `429`: honor `Retry-After` strictly;
- `503`: honor `Retry-After` when supplied;
- other `5xx`, network errors, and timeouts: exponential backoff;
- source backoff is persisted and shared by Cron and `/latest`;
- the relay does not create concurrent retry storms against AIHOT.

---

## Security model

### Secrets never belong in the repository

Do not commit or log:

- webhook URLs;
- Telegram bot tokens / chat IDs;
- ntfy tokens;
- generic webhook secrets;
- `LATEST_ACCESS_KEY`.

Use Cloudflare Secrets.

### Upstream text is untrusted

AIHOT ultimately reflects public source content, so rendered text is treated as untrusted input:

- HTML / Markdown / mrkdwn escaping;
- mass-mention neutralization such as `@everyone`, `@channel`, `@here`, and `@all`;
- only `http:` / `https:` URLs are accepted;
- Telegram HTML is escaped;
- Slack / WeCom / Feishu / DingTalk use platform-appropriate safe formatting;
- Generic Webhook templates use structured JSON substitution;
- non-ASCII ntfy `Title` values use RFC 2047 Base64 encoding.

---

## Migration and state

V4 uses a multi-key KV protocol instead of one large mutable state object.

When migrating from an older state version:

- the relay fetches a full AIHOT snapshot;
- the current snapshot becomes the baseline;
- historical reset events are not replayed;
- old in-flight retry intent that cannot be represented safely in the V4 signal/delivery model is intentionally abandoned and diagnosed;
- this prioritizes preventing a migration-time historical notification flood.

---

## Local development and verification

```bash
npm ci
npm test
npm run lint
npx wrangler deploy --dry-run
```

GitHub Actions runs the same core checks for pull requests and pushes to `main`.

Technology stack:

- Node.js 22
- Cloudflare Workers / Wrangler 4
- Cloudflare Workers KV
- Vitest 4 + `@cloudflare/vitest-plugin`
- ESLint 9

---

## FAQ

### Why not scrape Tibo / X directly?

Because that is not the problem this repository needs to solve. AIHOT already maintains the monitoring, translation, Beijing-time conversion, event curation, and public API. Duplicating the scraping layer would be more expensive and usually more fragile.

This repository focuses on reliable notification delivery.

### Will first deployment replay every historical reset?

No. First run uses baseline semantics: the current snapshot becomes known state without a historical notification flood.

### Why can duplicates still happen?

Because the system intentionally promises at-least-once rather than pretending to provide webhook-level exactly-once semantics. A tiny crash or stale-read window can legitimately cause a retry after the external target already accepted the previous attempt.

### Why can healthy channels receive a message when another channel fails?

Each target has independent delivery state. A bad webhook does not block unrelated targets.

### Is `/latest` public?

The route path is public, but the capability is not. Only a caller holding the high-entropy `LATEST_ACCESS_KEY` can execute it; knowing the Worker hostname or `/latest` path is not sufficient.

### Why is `/latest` still GET?

It is a deliberate usability tradeoff: the complete private URL can be bookmarked on a phone or added to the home screen for one-tap full-path testing. Security is balanced with a high-entropy secret, pre-fetch authentication, HEAD/prefetch protection, cooldown, source backoff, no-referrer/no-store headers, and Cloudflare observability query redaction.

### What about email?

Email is intentionally out of scope for V1. Webhook / bot / push channels avoid adding SMTP, provider, TLS, and anti-spam configuration complexity.

### Can this be used as an AIHOT mirror?

That is not a project goal. The relay stores only the state required for notification workflows and does not expose a mirror or bulk redistribution service for AIHOT data.

---

## Non-goals

V1 intentionally does not provide:

- direct X / Twitter / Tibo scraping;
- independent reset truth determination;
- an AIHOT mirror or proxy;
- multi-tenant SaaS accounts;
- an admin UI;
- leaderboards or analytics;
- a database beyond KV / Durable Objects;
- email delivery;
- automatic Cloudflare production deployment.

Keeping the project small makes it easier for it to reliably do one thing for a long time: **put important Codex Reset updates where you will actually see them.**

---

## License

Repository code is licensed under the [MIT License](LICENSE).

Again, the MIT License applies only to this repository's code. AIHOT API/data, Tibo/X source content, and other third-party content remain subject to their respective rights and terms.

---

## Acknowledgements

Special thanks to **[AIHOT](https://aihot.news/)**.

This relay is not an alternative to AIHOT. It is a small downstream tool built on top of the information curation and open integration work AIHOT already provides:

> **AIHOT makes reset information searchable, readable, and integratable; this project helps make it appear quickly in the places you actually watch.**

Thanks as well to everyone who publicly shares useful Codex status information, and to the Cloudflare Workers, Vitest, and broader open-source ecosystem.
