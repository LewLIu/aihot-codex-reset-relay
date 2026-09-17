import { parseIsoMs } from "../utils/time.js";

export class SnapshotValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "SnapshotValidationError";
    this.code = code;
  }
}

function stablePost(post) {
  return JSON.stringify({
    id: post.id,
    publishedAt: post.publishedAt,
    stage: post.stage ?? null,
    text: post.text ?? null,
    originalText: post.originalText ?? null,
    url: post.url ?? null,
  });
}

export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new SnapshotValidationError("invalid_snapshot");
  if (snapshot.schemaVersion !== 1) throw new SnapshotValidationError("schema_version");
  if (!Array.isArray(snapshot.events)) throw new SnapshotValidationError("events_not_array");
  parseIsoMs(snapshot.checkedAt);
  const seen = new Map();
  for (const event of snapshot.events) {
    if (!event || typeof event !== "object") throw new SnapshotValidationError("invalid_event");
    if (!Array.isArray(event.posts)) throw new SnapshotValidationError("posts_not_array");
    if (event.updatedAt != null) parseIsoMs(event.updatedAt);
    for (const post of event.posts) {
      if (!post?.id) throw new SnapshotValidationError("post_id_missing");
      parseIsoMs(post.publishedAt);
      const canonical = stablePost(post);
      if (seen.has(String(post.id)) && seen.get(String(post.id)) !== canonical) throw new SnapshotValidationError("duplicate_post_conflict");
      seen.set(String(post.id), canonical);
    }
  }
  return snapshot;
}
