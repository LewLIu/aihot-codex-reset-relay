import {expect,it} from "vitest";import {deliveryBackoffMs,classifyDeliveryFailure} from "../../src/notification/retry.js";
it("backs off and caps",()=>{expect(deliveryBackoffMs(1)).toBe(1800000);expect(deliveryBackoffMs(8)).toBe(86400000);});it("eighth retryable failure is permanent",()=>expect(classifyDeliveryFailure({retryable:true,code:"x"},8,0).status).toBe("permanent_failure"));
