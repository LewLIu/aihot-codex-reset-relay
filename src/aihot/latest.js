export function findLatestSourcePost(snapshot) {
  let best = null;
  for (const event of snapshot.events ?? []) {
    for (const post of event.posts ?? []) {
      if (!post?.id || !post?.publishedAt) continue;
      if (!best) {
        best = { event, post };
        continue;
      }
      const current = Date.parse(post.publishedAt);
      const previous = Date.parse(best.post.publishedAt);
      if (current > previous || (current === previous && String(post.id) > String(best.post.id))) best = { event, post };
    }
  }
  return best;
}
