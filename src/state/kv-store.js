const json = (value) => JSON.stringify(value);
const parse = (value) => value == null ? null : JSON.parse(value);
export const signalKey = (signalId) => `signal:${signalId}`;
export const deliveryKey = (signalId, targetId) => `delivery:${signalId}:${targetId}`;
export const targetKey = (targetId) => `target:${targetId}`;
async function listAll(kv, prefix) {
  const keys = []; let cursor;
  do { const page = await kv.list({ prefix, cursor }); keys.push(...page.keys.map((k) => k.name)); if (page.list_complete) break; cursor = page.cursor; } while (cursor);
  return keys;
}
export function createKvStore(kv) {
  return {
    async getMeta(){return parse(await kv.get("meta:v4"));},
    async putMeta(meta){await kv.put("meta:v4",json(meta));},
    async getSignal(signalId){return parse(await kv.get(signalKey(signalId)));},
    async ensureSignal(signal){const key=signalKey(signal.signalId);const existing=parse(await kv.get(key));if(existing)return existing;try{await kv.put(key,json(signal));return signal;}catch(error){const converged=parse(await kv.get(key));if(converged)return converged;throw error;}},
    async listSignals(){const keys=await listAll(kv,"signal:");const out=[];for(const key of keys){const value=parse(await kv.get(key));if(value)out.push(value);}return out;},
    async listReceiptSignals(){return (await this.listSignals()).filter((s)=>s.kind==="receipt_review");},
    async getDelivery(signalId,targetId){return parse(await kv.get(deliveryKey(signalId,targetId)));},
    async putDelivery(signalId,targetId,value){await kv.put(deliveryKey(signalId,targetId),json(value));},
    async getTargetRecord(targetId){return parse(await kv.get(targetKey(targetId)));},
    async putTargetRecord(targetId,value){await kv.put(targetKey(targetId),json(value));},
    async listTargetRecords(){const keys=await listAll(kv,"target:");const out=[];for(const key of keys){const value=parse(await kv.get(key));if(value)out.push({targetId:key.slice("target:".length),...value});}return out;},
    async getSourceBackoff(){return parse(await kv.get("source:backoff"));},
    async putSourceBackoff(value){if(value==null)await kv.delete("source:backoff");else await kv.put("source:backoff",json(value));},
    async getManualLatest(){return parse(await kv.get("manual:latest"));},
    async putManualLatest(value){await kv.put("manual:latest",json(value));},
    async getDiagnostics(){return parse(await kv.get("diag:last"));},
    async putDiagnostics(value){await kv.put("diag:last",json(value));},
    async reconcileTargets(targets,nowMs){const active=new Map(targets.map((t)=>[t.id,t]));const existing=await this.listTargetRecords();for(const target of targets){const current=await this.getTargetRecord(target.id);if(!current||current.status!=="active")await this.putTargetRecord(target.id,{channel:target.channel,status:"active",enabledAt:current?.enabledAt??nowMs,disabledAt:null});}const disabledIds=[];for(const record of existing){if(record.status==="active"&&!active.has(record.targetId)){disabledIds.push(record.targetId);await this.putTargetRecord(record.targetId,{channel:record.channel,status:"disabled",enabledAt:record.enabledAt??null,disabledAt:nowMs});}}if(disabledIds.length){for(const signal of await this.listSignals()){for(const targetId of signal.targetIds??[]){if(!disabledIds.includes(targetId))continue;const delivery=await this.getDelivery(signal.signalId,targetId);if(!delivery||delivery.status==="retry_wait")await this.putDelivery(signal.signalId,targetId,{status:"disabled",disabledAt:nowMs});}}}return{disabledIds};},
    async loadEligibleBacklog(nowMs){const work=[];for(const signal of await this.listSignals()){for(const targetId of signal.targetIds??[]){const delivery=await this.getDelivery(signal.signalId,targetId);if(!delivery||(delivery.status==="retry_wait"&&Number(delivery.nextAttemptAt)<=nowMs))work.push({signal,targetId,delivery});}}return work;},
    async pruneTerminalSignals({nowMs,retentionMs=90*24*60*60_000}={}){let pruned=0;for(const signal of await this.listSignals()){const created=Date.parse(signal.discoveredAt??signal.sortAt??0);if(!Number.isFinite(created)||nowMs-created<retentionMs)continue;const deliveries=[];for(const targetId of signal.targetIds??[])deliveries.push(await this.getDelivery(signal.signalId,targetId));const terminal=deliveries.every((d)=>d&&["sent","permanent_failure","disabled"].includes(d.status));if(!terminal)continue;for(const targetId of signal.targetIds??[])await kv.delete(deliveryKey(signal.signalId,targetId));await kv.delete(signalKey(signal.signalId));pruned+=1;}return pruned;}
  };
}
export function baselineMigrationDiagnostics(legacyState){const out=["migrated"];if(legacyState?.pending||legacyState?.pendingDeliveries?.length)out.push("legacy_pending_abandoned");return out;}
