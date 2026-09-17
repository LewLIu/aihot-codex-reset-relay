import { buildReceiptNotification, buildSourcePostNotification } from "../notification/message.js";

function sortPosts(posts) {
  return [...posts].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || String(a.id).localeCompare(String(b.id)));
}
function sortSignals(a, b) {
  return Date.parse(a.sortAt) - Date.parse(b.sortAt) || a.signalId.localeCompare(b.signalId);
}
function computeWatermark(snapshot, previous) {
  const posts = snapshot.events.flatMap((e) => e.posts ?? []).filter((p) => p?.id && p?.publishedAt);
  if (!posts.length) return previous ?? null;
  const maxMs = Math.max(...posts.map((p) => Date.parse(p.publishedAt)));
  if (previous && Date.parse(previous.publishedAt) > maxMs) return previous;
  const publishedAt = posts.find((p) => Date.parse(p.publishedAt) === maxMs).publishedAt;
  return { publishedAt, postIdsAtPublishedAt: posts.filter((p) => p.publishedAt === publishedAt).map((p) => String(p.id)).sort() };
}
function receiptAlreadyExists(event, postIds, existing) {
  const set = new Set(postIds.map(String));
  return existing.some((signal) => signal.kind === "receipt_review" && signal.eventType === event.type && (signal.receiptAnchorPostIds ?? []).some((id) => set.has(String(id))));
}
export function detectSignals({ snapshot, meta, existingReceiptSignals = [], targetIds = [] }) {
  const watermark0 = meta?.watermark ?? null;
  const boundaryIds = new Set(watermark0?.postIdsAtPublishedAt?.map(String) ?? []);
  const diagnostics = [];
  const signals = [];
  const baselineReceiptSignals = [];
  for (const event of snapshot.events) {
    for (const post of event.posts ?? []) {
      if (!post?.id || !post?.publishedAt || !watermark0) continue;
      const postMs = Date.parse(post.publishedAt);
      const boundaryMs = Date.parse(watermark0.publishedAt);
      const isNew = postMs > boundaryMs || (postMs === boundaryMs && !boundaryIds.has(String(post.id)));
      if (!isNew) continue;
      signals.push({ signalId:`post:${post.id}`, kind:"source_post", discoveredAt:snapshot.checkedAt, sortAt:post.publishedAt, notification:buildSourcePostNotification(event, post), targetIds:[...targetIds] });
    }
    if (event.status === "confirmed" && event.confirmationBasis === "receipt_review") {
      const anchors = sortPosts((event.posts ?? []).filter((p) => p?.id && p?.publishedAt));
      if (!anchors.length) { diagnostics.push("unanchored_receipt_review"); continue; }
      const postIds = anchors.map((p) => String(p.id));
      const candidate = { signalId:`receipt_review:${event.type}:${anchors[0].id}`, kind:"receipt_review", eventType:event.type, anchorPostId:String(anchors[0].id), receiptAnchorPostIds:postIds, discoveredAt:snapshot.checkedAt, sortAt:snapshot.checkedAt, notification:buildReceiptNotification(event, snapshot), targetIds:[...targetIds] };
      if (!watermark0) baselineReceiptSignals.push(candidate);
      else if (!receiptAlreadyExists(event, postIds, existingReceiptSignals)) signals.push(candidate);
    }
  }
  signals.sort(sortSignals);
  return { signals, watermark: computeWatermark(snapshot, watermark0), diagnostics, baselineReceiptSignals };
}
