import { fetchCodexResets } from "../aihot/client.js";
import { findLatestSourcePost } from "../aihot/latest.js";
import { validateSnapshot } from "../aihot/validate.js";
import { parseTargets } from "../config/targets.js";
import { buildSourcePostNotification } from "../notification/message.js";
import { defaultAdapters } from "../notification/dispatcher.js";
import { createKvStore } from "../state/kv-store.js";
import { constantTimeEqual } from "../utils/crypto.js";
import { sourceBackoffMs } from "../utils/time.js";
function headers() { return { "Cache-Control":"no-store", "Referrer-Policy":"no-referrer", "X-Robots-Tag":"noindex, nofollow", "Content-Type":"application/json; charset=utf-8" }; }
function json(body,status=200){return new Response(JSON.stringify(body),{status,headers:headers()});}
function speculative(request){const value=`${request.headers.get("Sec-Purpose")??""} ${request.headers.get("Purpose")??""}`.toLowerCase();return value.includes("prefetch")||value.includes("prerender");}
function backoffRecord(prior,source,nowMs){const attemptCount=(prior?.attemptCount??0)+1;return{attemptCount,retryNotBefore:source.retryNotBefore??nowMs+sourceBackoffMs(attemptCount),lastStatus:source.status??null,lastFailureAt:nowMs,reason:source.status?`http_${source.status}`:source.code??"source_error",updatedAt:nowMs};}
export async function sendLatestToTargets(targets,note,{adapters=defaultAdapters,fetchFn=fetch,concurrency=3}={}){const queue=[...targets],results=[];async function worker(){while(queue.length){const target=queue.shift();const adapter=adapters[target.channel];const result=adapter?await adapter.send(target,note,{fetchFn}):{ok:false,code:"unsupported_channel"};results.push({channel:target.channel,ok:result.ok===true,code:result.ok?null:result.code??"send_failed"});}}await Promise.all(Array.from({length:Math.min(concurrency,queue.length||1)},()=>worker()));return results;}
export async function handleLatest(request, env, { fetchFn=fetch, nowMs=Date.now(), adapters=defaultAdapters, store=createKvStore(env.CODEX_RESET_STATE) }={}) {
  if (request.method === "HEAD") return new Response(null,{status:204,headers:headers()});
  if (request.method !== "GET") return json({ok:false,reason:"method_not_allowed"},405);
  if (speculative(request)) return new Response(null,{status:204,headers:headers()});
  const url=new URL(request.url);
  if (!env.LATEST_ACCESS_KEY || !constantTimeEqual(url.searchParams.get("key"), env.LATEST_ACCESS_KEY)) return json({ok:false,reason:"forbidden"},403);
  const manual=await store.getManualLatest(); if (manual?.lastAcceptedAt && nowMs-Date.parse(manual.lastAcceptedAt)<10_000) return json({ok:false,reason:"cooldown"},429);
  const backoff=await store.getSourceBackoff(); if (backoff?.retryNotBefore && Number(backoff.retryNotBefore)>nowMs) return json({ok:false,reason:"source_backoff",retryAt:backoff.retryNotBefore},429);
  await store.putManualLatest({lastAcceptedAt:new Date(nowMs).toISOString()}); const source=await fetchCodexResets({etag:null,fetchFn,nowMs});
  if (source.kind!=="snapshot") { if (source.kind==="source_error") await store.putSourceBackoff(backoffRecord(backoff,source,nowMs)); return json({ok:false,reason:source.kind},source.status===429?429:502); }
  let snapshot; try { snapshot=validateSnapshot(source.snapshot); } catch { return json({ok:false,reason:"invalid_snapshot"},502); }
  await store.putSourceBackoff(null); const latest=findLatestSourcePost(snapshot); if(!latest) return json({ok:false,reason:"no_source_post"},404);
  const {targets,errors}=await parseTargets(env); const note=buildSourcePostNotification(latest.event,latest.post); const results=await sendLatestToTargets(targets,note,{adapters,fetchFn,concurrency:3});
  return json({ok:results.every(r=>r.ok),post:{id:String(latest.post.id),publishedAt:latest.post.publishedAt},targets:results,configErrorCount:errors.length});
}
