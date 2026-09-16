# AIHOT Reset Relay — Design Review Clarifications

Date: 2026-09-16
Applies to: `2026-09-16-aihot-reset-relay-design.md`

These clarifications are normative and were added during the design self-review before implementation planning.

## 1. Equal publication timestamps are not historical backfill

For an unseen `post.id`, historical-backfill classification must use a strict comparison:

- `publishedAt < latestPublishedAt` → historical backfill/regrouping; record as known and do not notify.
- `publishedAt >= latestPublishedAt` → eligible as a new source-post signal.

This avoids dropping a genuinely new post when two source posts share the same timestamp precision.

## 2. Removed delivery targets become disabled, not permanently pending

A pending delivery whose target is no longer present in the current runtime configuration must not remain an unhealthy, endlessly retried item.

When a previously known target is no longer configured:

- mark that delivery as `disabled`;
- exclude it from retry attempts;
- exclude it from active pending-delivery health counts;
- allow completed/disabled historical signals to be pruned by the normal retention policy.

If a target is later configured again, it participates only in signals discovered after it is active again. Historical notifications are not replayed merely because a target was re-added.

This preserves the V1 rule that new or reconfigured notification targets do not receive historical alerts.
