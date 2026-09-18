import { plainText, neutralizeMentions } from "../../utils/text.js";
import { httpFailure, safeJson, timeoutSignal, retryAfterMs } from "./_shared.js";
export async function send(target, note, { fetchFn=fetch }={}) {
  const content=neutralizeMentions(plainText(note));
  const body=target.config.msgType === "text" ? {msgtype:"text",text:{content}} : {msgtype:"markdown",markdown:{content}};
  try { const r=await fetchFn(target.config.url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:timeoutSignal()}); if(!r.ok) return {...httpFailure(r.status),retryAfterMs:retryAfterMs(r)}; const j=await safeJson(r); return j?.errcode===0?{ok:true}:{ok:false,retryable:false,code:"wework_business_error"}; } catch(e){return {ok:false,retryable:true,code:e?.name==="TimeoutError"?"timeout":"network"};}
}
