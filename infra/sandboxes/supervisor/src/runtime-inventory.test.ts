import {describe,it,expect} from "vitest";
import {parseObservation} from "./supervisor-logic.js";
describe("runtime inventory",()=>{it.each(["0xzz","0x0","0x-1","0x20000000000001"])("rejects %s",id=>{const r=parseObservation(`IMAGE YQ==\nINVENTORY_STATUS validnonempty\nWINDOWS_JSON ${JSON.stringify([{id}])}`);expect(r.windowInventoryStatus).toBe("unknown");expect(r.windows).toBeUndefined();});});
