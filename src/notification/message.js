export function buildSourcePostNotification(event, post) {
  return {
    signalId: `post:${post.id}`,
    kind: "source_post",
    title: event.title || "Codex Reset 动态",
    eventType: event.type ?? null,
    eventStatus: event.status ?? null,
    scope: event.scope ?? null,
    publishedAt: post.publishedAt,
    scheduleLabel: event.schedule?.label ?? null,
    occurredOn: event.occurredOn ?? null,
    confirmationBasis: event.confirmationBasis ?? null,
    content: post.text ?? post.originalText ?? "",
    sourceUrl: post.url ?? null,
    aihotUrl: event.url ?? null,
  };
}

export function buildReceiptNotification(event, snapshot) {
  return {
    kind: "receipt_review",
    eventType: event.type,
    eventStatus: "confirmed",
    title: event.title,
    scope: event.scope ?? null,
    occurredOn: event.occurredOn ?? null,
    confirmationBasis: "receipt_review",
    observedAt: snapshot.checkedAt,
    content: "AIHOT 已通过 receipt review 确认该 Codex 重置事件。",
    sourceUrl: null,
    aihotUrl: event.url ?? null,
  };
}
