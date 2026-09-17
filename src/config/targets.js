import { sha256Prefix128 } from "../utils/crypto.js";

function splitList(raw) {
  if (raw == null || raw === "") return [];
  const values = String(raw).split(";").map((v) => v.trim());
  if (values.some((v) => v === "")) throw new Error("empty_list_item");
  return values;
}

function expand(values, count, fallback) {
  if (values.length === 0) return Array(count).fill(fallback);
  if (values.length === 1) return Array(count).fill(values[0]);
  if (values.length === count) return values;
  throw new Error("cardinality_mismatch");
}

async function makeTarget(channel, config, identityParts) {
  const hash = await sha256Prefix128([channel, ...identityParts].join("\n"));
  return { id: `${channel}:${hash}`, channel, config };
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
      if (!tokens.length || tokens.length !== chats.length) throw new Error("cardinality_mismatch");
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
        targets.push(await makeTarget("ntfy", config, [config.server, config.topic]));
      }
    }
  } catch (error) {
    errors.push({ channel: "ntfy", code: error.message });
  }

  return { targets, errors };
}
