# AIHOT Codex Reset Relay

自托管 Cloudflare Worker：每 30 分钟读取 AIHOT Codex Reset API，发现新的 source post / receipt-review confirmation 后，推送到企业微信、飞书、钉钉、Telegram、Bark、ntfy、Slack 或 Generic Webhook。

> 本项目是独立社区项目，不是 AIHOT 官方项目。特别感谢 AIHOT 提供 Codex Reset 事件整理、中文信息与公开 API。仓库 MIT 许可证仅覆盖本仓库代码，不覆盖 AIHOT API/数据或第三方来源内容；使用者应遵守 AIHOT 当前的数据/API 使用条款。

## 部署

```bash
npm install
npx wrangler login
npx wrangler secret put LATEST_ACCESS_KEY
npx wrangler deploy
```

Cron 为 `*/30 * * * *`，KV binding 为 `CODEX_RESET_STATE`。

`LATEST_ACCESS_KEY` 请使用至少 256-bit 随机高熵值。手机可收藏：

```text
https://YOUR_WORKER.workers.dev/latest?key=YOUR_256_BIT_RANDOM_KEY
```

完整收藏 URL 本身就是凭证；泄露后必须轮换 `LATEST_ACCESS_KEY`。`/latest` 仍是 GET，但 HEAD、prefetch/prerender、错误 key、10 秒 cooldown、AIHOT source backoff 都会在任何外部请求前拦截。`wrangler.jsonc` 已启用 `observability.redact_query_string=true`，用于避免 `/latest?key=...` 的 query string 被写入 Workers logs/traces；部署时不要移除该设置。

## 通知配置

可用变量：`WEWORK_WEBHOOK_URL`, `WEWORK_MSG_TYPE`, `FEISHU_WEBHOOK_URL`, `DINGTALK_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `BARK_URL`, `NTFY_TOPIC`, `NTFY_SERVER_URL`, `NTFY_TOKEN`, `SLACK_WEBHOOK_URL`, `GENERIC_WEBHOOK_URL`, `GENERIC_WEBHOOK_TEMPLATE`。

多个值使用 `;` 分隔；URL 内 literal `;` 请编码为 `%3B`，空元素非法。Telegram token/chat 数量必须完全一致。ntfy 以 topic 数量为 N，server/token 可为空、1 个广播到全部，或 N 个按索引配对，否则配置错误。

## 可靠性与安全

AIHOT 使用 ETag 条件请求；429/503 `Retry-After` 优先，其他错误指数退避。Delivery 30m→1h→2h→4h→8h→16h→24h，最多 8 次；每次 Cron 最多 10 次投递、最多 3 个 target stream 并发，同 target 串行。`signal:*` immutable，缺少 `delivery:*` 就是 pending。语义为 at-least-once，不承诺 distributed exactly-once。V3→V4 baseline 不回放历史，无法完整恢复的旧 pending intent 主动放弃并记录诊断。

AIHOT 文本按不可信输入处理：markup 转义、mass mention 中和、URL 仅允许 http/https、Generic Webhook 先解析 JSON 模板再替换。ntfy 非 ASCII Title 使用 RFC 2047 Base64。
