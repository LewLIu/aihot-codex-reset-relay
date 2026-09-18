import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { findLatestSourcePost } from "../../src/aihot/latest.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/aihot-response.json", import.meta.url), "utf8"),
);

it("selects global latest by post.publishedAt, not events[0]", () => {
  expect(findLatestSourcePost(fixture).post.id).toBe("post-latest");
});
