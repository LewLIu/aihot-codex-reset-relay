import { expect, it, vi } from "vitest";
import { reconcileTargets } from "../../src/notification/dispatcher.js";

it("disables removed targets and their pending deliveries using targetId records", async () => {
  const writes = [];
  const store = {
    getTargetRecord: vi.fn(async () => null),
    putTargetRecord: vi.fn(async (targetId, value) => writes.push({ type: "target", targetId, value })),
    listTargetRecords: vi.fn(async () => [
      { targetId: "telegram:old", channel: "telegram", status: "active", enabledAt: 1, disabledAt: null },
    ]),
    listSignals: vi.fn(async () => [
      { signalId: "post:1", targetIds: ["telegram:old"] },
    ]),
    getDelivery: vi.fn(async () => null),
    putDelivery: vi.fn(async (signalId, targetId, value) => writes.push({ type: "delivery", signalId, targetId, value })),
  };

  await reconcileTargets(store, [], 1234);

  expect(writes).toContainEqual({
    type: "target",
    targetId: "telegram:old",
    value: {
      targetId: "telegram:old",
      channel: "telegram",
      status: "disabled",
      enabledAt: 1,
      disabledAt: 1234,
    },
  });
  expect(writes).toContainEqual({
    type: "delivery",
    signalId: "post:1",
    targetId: "telegram:old",
    value: { status: "disabled", attemptCount: 0, lastAttemptAt: 1234 },
  });
});
