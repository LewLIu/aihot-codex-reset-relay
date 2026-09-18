import { expect, it } from "vitest";
import fixture from "../fixtures/aihot-response.js";
import { findLatestSourcePost } from "../../src/aihot/latest.js";

it("selects global latest by post.publishedAt, not events[0]", () => {
  expect(findLatestSourcePost(fixture).post.id).toBe("post-latest");
});
