import { expect, it, vi } from "vitest";
import { fetchCodexResets } from "../../src/aihot/client.js";
it("sends If-None-Match and normalizes 304",async()=>{const fetchFn=vi.fn(async(_url,init)=>{expect(init.headers.get("If-None-Match")).toBe('"abc"');return new Response(null,{status:304});});await expect(fetchCodexResets({etag:'"abc"',fetchFn,nowMs:0})).resolves.toEqual({kind:"not_modified"});});
it("returns retryNotBefore for 503 Retry-After",async()=>{const fetchFn=vi.fn(async()=>new Response("busy",{status:503,headers:{"Retry-After":"120"}}));const result=await fetchCodexResets({fetchFn,nowMs:1000});expect(result.retryNotBefore).toBe(121000);});
