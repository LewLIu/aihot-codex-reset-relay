# AIHOT Codex Reset Relay

[![CI](https://github.com/LewLIu/aihot-codex-reset-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/LewLIu/aihot-codex-reset-relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

**把 AIHOT 的 Tibo / Codex 重置监控，变成你自己的多渠道实时提醒。**

这是一个自托管的 Cloudflare Worker。它默认每 30 分钟读取一次 AIHOT Codex Reset API，识别新的重置 / 发重置卡相关 source post 与可锚定的 receipt-review confirmation，再按目标独立推送到企业微信、飞书、钉钉、Telegram、Bark、ntfy、Slack 或 Generic Webhook。

- 无需自建服务器
- 无需本地电脑常驻
- 基于 Cloudflare Workers + KV
- 支持 8 类通知渠道
- 支持多目标、去重、失败重试和目标生命周期管理
- 提供适合手机收藏的一键 `/latest` 全链路测试入口
- AIHOT API 与通知投递状态解耦：上游返回 `304 Not Modified` 时，本地失败投递仍可继续重试

[English README](README_EN.md)

> [!IMPORTANT]
> 本项目是独立社区项目，**不是 AIHOT、OpenAI 或 Codex 的官方项目**。本项目不自行抓取 Tibo/X，不自行判断“是否真的发生了重置”，也不镜像 AIHOT 数据；它只消费 AIHOT 提供的公开 Codex Reset 数据，并负责可靠地将新动态转发到你自己的通知渠道。

---

## 为什么做这个项目？

Codex 的额外重置、全员重置和重置卡动态，往往来自 Tibo 的公开帖子。对日常大量使用 Codex 的人来说，错过这些消息并不只是“少看了一条推文”：你可能不知道额度已经重置、没有及时继续使用，甚至错过一段本可以利用的 Token / 额度窗口。

AIHOT 已经解决了最难的一层：**持续跟踪、整理、翻译和结构化这些公开信息**。

这个项目解决的是下一层问题：

> **如何把 AIHOT 整理好的 Codex Reset 信息，稳定地送到你真正会看的地方。**

例如：

```text
Tibo 的公开帖子
        ↓
      AIHOT
  重置监控 / 中文整理
        ↓
GET /api/v1/codex-resets
        ↓
AIHOT Codex Reset Relay
   Cloudflare Worker
        ↓
┌────────┬────────┬────────┬────────┐
│ 企业微信 │  飞书   │  钉钉   │ Telegram │
├────────┼────────┼────────┼────────┤
│  Bark  │  ntfy  │ Slack  │ Webhook │
└────────┴────────┴────────┴────────┘
```

---

## 关于 AIHOT，以及为什么特别感谢它

[AIHOT](https://aihot.news/) 是一个面向 AI 信息获取与 Agent 接入的公共信息服务。除了 AI 资讯、热点、日报等内容外，它还提供 Skill、MCP、RSS 和 REST API 等匿名只读接入方式，让开发者和 Agent 可以直接消费结构化信息。

对于本项目最重要的是 AIHOT 的 **Tibo 重置监控**。

AIHOT 对这类信息做了大量本项目没有必要重复建设的工作，包括：

- 持续跟踪 Tibo 的公开 Codex 重置相关帖子；
- 将 **全员重置**、**发重置卡 / 补卡** 等事件分开整理；
- 区分预告、确认等状态，而不是把“预计会重置”直接当成“已经重置”；
- 统一换算为北京时间；
- 提供中文译文，同时保留原帖入口；
- 把历史记录整理成可查询的重置日历；
- 提供无需 API Key 的公开只读 REST API，方便开发者接入自己的工具；
- AIHOT 自己也会把新的重置、发卡预告和确认动态推送到群聊。

相关入口：

- **Tibo 重置监控 / 重置日历**：<https://aihot.news/codex-reset>
- **Codex Reset API**：<https://aihot.news/api/v1/codex-resets>
- **Agent / API 接入说明**：<https://aihot.news/agent>
- **AIHOT 更新日志**：<https://aihot.news/changelog>

AIHOT 当初向用户介绍这个功能时，希望大家“不用再怕 Tibo 重置 Codex 后没看到而浪费 Token”。这也是本项目继续往前做一层通知 Relay 的直接动机。

**特别感谢 AIHOT 对公开信息的持续整理、中文翻译、状态核验以及开放 API。** 没有这些结构化数据，这个项目要么需要自行维护脆弱的 X/Tibo 抓取链路，要么只能退化成不可靠的文本监控。

也借用 AIHOT 上线这项功能时那句很可爱的祝福：**希望大家少刷几次推，多领几次卡，快乐 Coding。**

> 本仓库的 MIT License 只覆盖本项目代码，**不覆盖 AIHOT API / 数据，也不覆盖 Tibo 或其他第三方来源内容**。请根据你的使用场景遵守 AIHOT 当前的 API / 数据使用说明和原始内容平台的相关规则。

---

## 功能一览

### 自动监控

- Cloudflare Cron 默认每 **30 分钟**执行一次；
- 使用 AIHOT `ETag` / `If-None-Match` 条件请求；
- 不依赖 `events[0]` 判断最新消息，而是遍历完整 snapshot；
- source post 使用稳定 `post.id` 去重；
- receipt-review confirmation 使用可解释、可持久化的 source-post anchor 规则；
- 历史回填不会被误判成新消息；
- 首次部署 / V3→V4 baseline 不会把历史 Reset 全量轰炸到通知渠道。

### 可靠投递

- 每个通知目标独立记录投递结果；
- 某个 Telegram / Webhook 失败，不影响其他目标成功；
- 失败目标后续单独重试；
- retry 采用 `30m → 1h → 2h → 4h → 8h → 16h → 24h`，最多 8 次；
- 每轮 Cron 最多 10 次 delivery attempt；
- 最多 3 个 target stream 并发；
- 同一 target 内保持顺序发送；
- 删除或轮换目标后，旧 target 会终止历史 pending，不会把历史通知误发到新目标。

### 手机一键 `/latest`

你可以把一个私有 URL 收藏到手机浏览器：

```text
https://YOUR_WORKER.workers.dev/latest?key=YOUR_256_BIT_RANDOM_KEY
```

点击后会完整执行一次：

```text
验证访问密钥
  ↓
检查 cooldown / AIHOT backoff
  ↓
实时请求 AIHOT
  ↓
验证完整 snapshot
  ↓
查找全局最新 source post
  ↓
发送到当前全部通知目标
```

它适合用来验证“AIHOT → Worker → 机器人”整条链路，而不是只测试某个 webhook。

`/latest` 不修改自动 Cron 的 signal / delivery / watermark / ETag 状态，因此手动测试不会吃掉下一次正常自动通知。

---

## 支持的通知渠道

| 渠道 | 配置项 | 备注 |
|---|---|---|
| 企业微信 WeCom | `WEWORK_WEBHOOK_URL` | 默认 Markdown；可配 `WEWORK_MSG_TYPE=text` |
| 飞书 Feishu / Lark | `FEISHU_WEBHOOK_URL` | Webhook 机器人 |
| 钉钉 DingTalk | `DINGTALK_WEBHOOK_URL` | Markdown 机器人 |
| Telegram | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | 多账号按索引一一配对 |
| Bark | `BARK_URL` | 适合 iPhone / iPad 推送 |
| ntfy | `NTFY_TOPIC` + 可选 `NTFY_SERVER_URL` / `NTFY_TOKEN` | 支持官方或自托管 ntfy |
| Slack | `SLACK_WEBHOOK_URL` | Incoming Webhook |
| Generic Webhook | `GENERIC_WEBHOOK_URL` + 可选 `GENERIC_WEBHOOK_TEMPLATE` | 用于其他机器人或自动化平台 |

没有配置的渠道会自动跳过。

---

## 快速开始

### 1. 前置条件

建议准备：

- 一个 Cloudflare 账号；
- Node.js 22；
- 至少一个通知渠道的 webhook / token；
- 一个用于 `/latest` 的随机高熵访问密钥。

克隆仓库：

```bash
git clone https://github.com/LewLIu/aihot-codex-reset-relay.git
cd aihot-codex-reset-relay
npm ci
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

项目已经在 `wrangler.jsonc` 中声明：

```text
Worker name: aihot-codex-reset-relay
KV binding: CODEX_RESET_STATE
Cron: */30 * * * *
```

### 3. 设置 `/latest` 访问密钥

至少使用 **256-bit 随机高熵值**：

```bash
npx wrangler secret put LATEST_ACCESS_KEY
```

不要使用生日、手机号、普通密码或短 MD5 值。

### 4. 配置通知渠道

推荐把 webhook、Bot Token、Chat ID 等目标配置也作为 Cloudflare Secret 管理，例如：

```bash
npx wrangler secret put WEWORK_WEBHOOK_URL
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put SLACK_WEBHOOK_URL
```

只需要设置你实际使用的渠道。

### 5. 部署

```bash
npx wrangler deploy
```

部署后建议依次检查：

```text
GET /
GET /health
GET /latest?key=<你的 LATEST_ACCESS_KEY>
```

然后等待至少一次真实 Cron 执行，确认自动监控状态正常推进。

---

## 多目标配置

同一渠道可以配置多个目标，使用 `;` 分隔：

```text
WEBHOOK_A;WEBHOOK_B;WEBHOOK_C
```

规则：

- 分隔符前后空白会被 trim；
- 空元素非法；
- URL 本身如果真的需要 literal `;`，请编码为 `%3B`；
- 不会“猜测”配对关系，配置数量不匹配会直接作为配置错误处理。

### Telegram

```text
TELEGRAM_BOT_TOKEN=token1;token2
TELEGRAM_CHAT_ID=chat1;chat2
```

二者数量必须完全一致，并按 index 配对。

### ntfy

以 `NTFY_TOPIC` 数量 `N` 作为 target 数：

```text
NTFY_TOPIC=topic-a;topic-b
```

`NTFY_SERVER_URL` / `NTFY_TOKEN`：

- 不配置：使用默认 server / 无 token；
- 配 1 个：广播应用到全部 topic；
- 配 N 个：按 index 配对；
- 其他数量：配置错误。

---

## Generic Webhook 模板

如果只配置：

```text
GENERIC_WEBHOOK_URL
```

项目会发送默认 JSON payload。

如果配置 `GENERIC_WEBHOOK_TEMPLATE`，模板必须是合法 JSON。项目会**先解析 JSON，再递归替换字符串字段**，而不是把上游文本直接拼接进 JSON 字符串，从而降低模板注入和转义错误风险。

可使用的核心通知信息包括 title / content / source URL / AIHOT URL 等 normalized 字段。

---

## HTTP 接口

### `GET /`

返回公开、脱敏的运行状态，例如：

- service / version；
- 最近一次检查时间；
- AIHOT source 状态；
- watermark / source checked time；
- 已配置 target 数量；
- pending delivery 数量；
- 最近一次 Cron 状态。

不会返回 webhook URL、Bot Token、Chat ID、target hash 或 `/latest` 密钥。

### `GET /health`

最小化健康检查接口，适合外部 uptime probe。

### `GET /latest?key=...`

手动全链路测试入口。

安全约束：

- 必须提供正确 `LATEST_ACCESS_KEY`；
- 错误 key 会在访问 AIHOT 之前直接拒绝；
- `HEAD /latest` 永远没有副作用；
- 浏览器 prefetch / prerender 不会触发通知；
- 10 秒 cooldown 在 AIHOT fetch 之前检查；
- AIHOT 正处于 `Retry-After` / source backoff 时不会绕过限制；
- 响应使用 `Cache-Control: no-store` / `Referrer-Policy: no-referrer` / `X-Robots-Tag: noindex, nofollow`；
- `wrangler.jsonc` 启用了 `observability.redact_query_string=true`，避免 `?key=...` 出现在 Workers Logs / Traces 的请求 URL 中。

**完整收藏 URL 本身就是凭证。** 如果怀疑泄露，请立刻轮换 `LATEST_ACCESS_KEY` 并更新手机书签。

---

## 工作原理

### 1. Source check 优先

每轮 Cron 先检查 AIHOT，而不是让历史失败队列无限阻塞新的 Reset 信息。

### 2. Snapshot 完整验证

收到 `200` 后，会先验证 schema、post ID 冲突、时间字段等基础契约。

如果 snapshot 不兼容或无法安全解析：

- 不产生新的 signal；
- 不推进新的 ETag / watermark；
- 已经持久化的本地 pending delivery 仍可继续重试。

### 3. Immutable watermark detection

同一次 snapshot 全程使用进入本轮时冻结的 `W0` 判断新旧消息，处理完成后才一次性提交 `W1`。

watermark 不是单纯一个 timestamp，而是：

```json
{
  "publishedAt": "2026-09-12T08:09:00Z",
  "postIdsAtPublishedAt": ["..."]
}
```

这样即使两条新帖子具有完全相同的 `publishedAt`，也不会因为时间精度相同而静默丢失。

### 4. Durable signal first

发现新 signal 后，会先把 immutable normalized notification 和当时的 target snapshot 持久化到 KV，再提交新的 ETag / watermark，之后才进入外部发送。

因此即使下一次 AIHOT 返回 `304 Not Modified`，本地依然知道“该发什么、发给谁”。

### 5. Per-target delivery

物理 KV 不是一份频繁覆盖的大 JSON：

```text
meta:v4
signal:<signalId>
delivery:<signalId>:<targetId>
target:<targetId>
source:backoff
manual:latest
diag:last
```

`signal:*` 是 immutable work item。

**不存在 `delivery:*` 就表示 pending**，不会为了表示 pending 而先写一次 delivery key，再几百毫秒后覆盖成 sent，从而避开 Workers KV 同-key 高频写入问题。

---

## Delivery 语义

项目承诺的是 **at-least-once**，不是 distributed exactly-once。

正常情况下，同一 signal / target 成功记录后不会被主动重复发送。但以下极小窗口仍可能产生重复：

1. 外部 webhook 已经成功接收；
2. Worker 尚未来得及把 `sent` durable ACK 写入 KV 就崩溃；
3. 或另一个 execution 暂时读到 KV 的 stale value。

这种设计优先保证：

> **可以极少量重复，但不要静默漏掉重要 Reset 通知。**

---

## AIHOT 上游错误与退避

- `304`：没有新的 snapshot，但本地 pending delivery 仍继续处理；
- `429`：严格遵守 `Retry-After`；
- `503`：如果带 `Retry-After`，同样严格遵守；
- 其他 `5xx` / network / timeout：指数退避；
- source backoff 会持久化，Cron 和 `/latest` 共用；
- 不使用并发重试风暴轰炸 AIHOT。

---

## 安全设计

### Secret 不进入仓库

以下内容都不应写入代码、README 示例或日志：

- webhook URL；
- Telegram Bot Token / Chat ID；
- ntfy token；
- Generic Webhook secret；
- `LATEST_ACCESS_KEY`。

请使用 Cloudflare Secrets。

### 上游文本是不可信输入

AIHOT 数据最终来源于公开帖子，因此所有文本在进入目标平台前都按 untrusted content 处理：

- HTML / Markdown / mrkdwn 转义；
- 中和 `@everyone` / `@channel` / `@here` / `@all` 等 mass mention；
- URL 只允许 `http:` / `https:`；
- Telegram HTML 安全转义；
- Slack / WeCom / Feishu / DingTalk 按各自平台格式处理；
- Generic Webhook 使用结构化 JSON 模板替换；
- ntfy 非 ASCII `Title` 使用 RFC 2047 Base64 编码。

---

## 状态与迁移

V4 使用多 key KV 协议，而不是单一 state 大对象。

从旧版本升级时：

- 如果发现 `stateVersion !== 4`，会重新获取一次完整 AIHOT snapshot；
- 当前 snapshot 作为 baseline；
- 不补发历史 Reset；
- 无法可靠表达成 V4 signal/delivery 的旧 in-flight retry 会主动 abandon，并留下诊断信息；
- 这样优先避免升级时突然产生历史通知洪泛。

---

## 本地开发与验证

```bash
npm ci
npm test
npm run lint
npx wrangler deploy --dry-run
```

GitHub Actions 会在 Pull Request 和 `main` push 上运行同样的核心验证。

项目使用：

- Node.js 22
- Cloudflare Workers / Wrangler 4
- Cloudflare Workers KV
- Vitest 4 + `@cloudflare/vitest-plugin`
- ESLint 9

---

## FAQ

### 为什么不直接抓 Tibo / X？

因为这不是本项目真正需要解决的问题。AIHOT 已经维护了公开帖监控、中文翻译、北京时间换算、事件整理和 API。重复构建一套 X 抓取链路不仅成本更高，而且通常更加脆弱。

本项目选择专注于“可靠通知”。

### 第一次部署会把所有历史重置都发给我吗？

不会。首次运行使用 baseline 语义，当前 snapshot 会被记为已知状态，不进行历史洪泛。

### 为什么可能收到重复通知？

因为系统选择 at-least-once，而不是假装提供 webhook 场景难以真正实现的 exactly-once。外部发送成功但 durable ACK 失败的极小窗口里，后续重试可能再次发送。

### 为什么某个渠道失败了，其他渠道仍然能收到？

每个 target 有独立 delivery 状态。Dispatcher 使用独立 target stream，不会因为一个坏 webhook 阻塞所有其他目标。

### `/latest` 是不是公开测试接口？

路径公开，但执行能力不是公开的。只有拥有高熵 `LATEST_ACCESS_KEY` 的人才能触发；知道 Worker 域名或 `/latest` 路径本身没有用。

### `/latest` 为什么继续使用 GET？

这是一个刻意的产品取舍：方便把完整私有 URL 收藏到手机或添加到主屏幕，一点即可验证全链路。为平衡安全性，项目增加了高熵 secret、前置认证、prefetch/HEAD 防误触、cooldown、source backoff、no-referrer/no-store 以及 Cloudflare observability query redaction。

### 可以添加 Email 吗？

V1 暂未实现 Email。当前项目优先选择 webhook / Bot / push 类渠道，避免引入 SMTP、邮件供应商、TLS 与反垃圾配置的额外复杂度。

### 可以把它当 AIHOT API 镜像吗？

不建议，也不是本项目目标。本项目只为通知工作流保存必要的状态，不提供 AIHOT 数据镜像或批量再分发服务。

---

## 项目边界

V1 明确不做：

- X / Twitter / Tibo 自行抓取；
- 自己判断 Reset 真伪；
- AIHOT 数据镜像 / 代理；
- SaaS 多租户账号系统；
- 管理后台；
- 排行榜或统计平台；
- 独立数据库 / Durable Objects；
- Email；
- 自动 Cloudflare 生产部署。

保持项目足够小，才能让它长期稳定地做一件事：**及时把重要的 Codex Reset 动态送到你面前。**

---

## License

本项目代码使用 [MIT License](LICENSE)。

再次说明：MIT 仅适用于这个仓库中的代码。AIHOT API / 数据、Tibo / X 原始内容以及其他第三方内容仍归各自权利方，并受各自条款约束。

---

## Acknowledgements

特别感谢 **[AIHOT](https://aihot.news/)**。

这个项目不是 AIHOT 的替代品，而是建立在 AIHOT 已经做好的信息整理与开放能力之上的一个小型 Relay：

> **AIHOT 负责让 Reset 信息变得可查、可读、可接入；本项目负责让它更容易在你真正会看的地方及时出现。**

也感谢所有公开分享 Codex 状态与使用信息的人，以及 Cloudflare Workers、Vitest 等开源 / 云平台生态。
