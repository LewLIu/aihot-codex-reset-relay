import { runResetMonitor } from "./monitor/reset-monitor.js";
import { handleHealth, handleStatus } from "./routes/status.js";
import { handleLatest } from "./routes/latest.js";
export default {
  async fetch(request, env) { const pathname=new URL(request.url).pathname; if(pathname==="/") return handleStatus(request,env); if(pathname==="/health") return handleHealth(request,env); if(pathname==="/latest") return handleLatest(request,env); return Response.json({ok:false,reason:"not_found"},{status:404}); },
  async scheduled(_controller, env, ctx) { ctx.waitUntil(runResetMonitor({env})); },
};
