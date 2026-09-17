# AIHOT Codex Reset Relay

A self-hosted Cloudflare Worker that polls AIHOT's Codex Reset API every 30 minutes and relays new source posts / anchored receipt-review confirmations to WeCom, Feishu, DingTalk, Telegram, Bark, ntfy, Slack, and generic webhooks.

This is an independent community project, not an official AIHOT project. Special thanks to AIHOT for Codex Reset curation, Chinese information, and the public API. The MIT license covers only this repository's code.

## Deploy

```bash
npm install
npx wrangler login
npx wrangler secret put LATEST_ACCESS_KEY
npx wrangler deploy
```

Cron: `*/30 * * * *`. KV binding: `CODEX_RESET_STATE`.

Use a random high-entropy (at least 256-bit) `LATEST_ACCESS_KEY` and bookmark `https://YOUR_WORKER.workers.dev/latest?key=YOUR_256_BIT_RANDOM_KEY`. The complete URL is a secret capability; rotate the secret if it leaks. `/latest` rejects HEAD, prefetch/prerender, bad keys, 10-second repeat calls, and active upstream backoff before contacting AIHOT.

Multiple targets use `;`; encode literal semicolons in URLs as `%3B`. Telegram token/chat counts must match. For ntfy, topic count is N; server/token can be absent, one broadcast value, or exactly N values.

Delivery is at-least-once with three target streams and a ten-attempt Cron budget. AIHOT text is untrusted: markup is escaped, mass mentions are neutralized, URLs are restricted to HTTP(S), generic templates are parsed as JSON before substitution, and Unicode ntfy titles use RFC 2047 encoding.
