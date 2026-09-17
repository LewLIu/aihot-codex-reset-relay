import {expect,it} from "vitest";import {encodeRfc2047} from "../../src/notification/channels/ntfy.js";
it("RFC2047 encodes unicode titles for Headers-compatible transport",()=>{const value=encodeRfc2047("重置通知");expect(value).toMatch(/^=\?UTF-8\?B\?.+\?=$/);expect(()=>new Headers({Title:value})).not.toThrow();});
