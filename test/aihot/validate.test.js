import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { validateSnapshot } from "../../src/aihot/validate.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/aihot-response.json", import.meta.url), "utf8"),
);

it("accepts schemaVersion 1", () => {
  expect(validateSnapshot(structuredClone(fixture)).schemaVersion).toBe(1);
});

it("rejects incompatible schema", () => {
  expect(() => validateSnapshot({ ...fixture, schemaVersion: 2 })).toThrow(/schema_version/);
});

it("rejects conflicting duplicate post ids", () => {
  const bad = structuredClone(fixture);
  bad.events[1].posts.push({
    id: "post-old",
    publishedAt: "2026-09-12T08:08:00Z",
    text: "conflict",
    url: "https://example.test/x",
  });
  expect(() => validateSnapshot(bad)).toThrow(/duplicate_post_conflict/);
});
