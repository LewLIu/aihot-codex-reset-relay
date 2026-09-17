import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { createKvStore } from "../../src/state/kv-store.js";
beforeEach(async()=>{let cursor;do{const p=await env.CODEX_RESET_STATE.list({cursor});await Promise.all(p.keys.map(k=>env.CODEX_RESET_STATE.delete(k.name)));if(p.list_complete)break;cursor=p.cursor;}while(cursor);});
it("stores signal and delivery on separate physical keys",async()=>{const store=createKvStore(env.CODEX_RESET_STATE);await store.ensureSignal({signalId:"post:1",kind:"source_post",targetIds:["wework:a"]});expect(await env.CODEX_RESET_STATE.get("delivery:post:1:wework:a")).toBeNull();await store.putDelivery("post:1","wework:a",{status:"sent"});expect(await env.CODEX_RESET_STATE.get("signal:post:1")).not.toBeNull();expect(await env.CODEX_RESET_STATE.get("delivery:post:1:wework:a")).not.toBeNull();expect(await env.CODEX_RESET_STATE.get("state:v4")).toBeNull();});
