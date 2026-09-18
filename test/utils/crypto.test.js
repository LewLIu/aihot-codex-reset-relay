import { expect, it } from "vitest";
import { constantTimeEqual, sha256Prefix128 } from "../../src/utils/crypto.js";
it("creates 128-bit lowercase hex fingerprints",async()=>expect(await sha256Prefix128("abc")).toMatch(/^[0-9a-f]{32}$/));
it("compares access keys",()=>{expect(constantTimeEqual("secret","secret")).toBe(true);expect(constantTimeEqual("secret","secrex")).toBe(false);expect(constantTimeEqual("secret","short")).toBe(false);});
