export default {
  schemaVersion: 1,
  timezone: "Asia/Shanghai",
  checkedAt: "2026-09-12T08:10:00Z",
  historyFrom: "2026-09-01T00:00:00Z",
  count: 2,
  events: [
    {
      id: "event-updated-later",
      type: "reset_credit",
      status: "confirmed",
      title: "Older source post but newer event update",
      scope: "all",
      updatedAt: "2026-09-12T09:00:00Z",
      confirmationBasis: "source_post",
      posts: [
        {
          id: "post-old",
          publishedAt: "2026-09-12T07:00:00Z",
          text: "old",
          url: "https://example.test/old",
        },
      ],
      url: "https://aihot.news/codex-reset/old",
    },
    {
      id: "event-real-latest",
      type: "direct_reset",
      status: "announced",
      title: "Actual newest source post",
      scope: "all",
      updatedAt: "2026-09-12T08:30:00Z",
      confirmationBasis: null,
      posts: [
        {
          id: "post-latest",
          publishedAt: "2026-09-12T08:09:00Z",
          text: "latest",
          url: "https://example.test/latest",
        },
      ],
      url: "https://aihot.news/codex-reset/latest",
    },
  ],
};
