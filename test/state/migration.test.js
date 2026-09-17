import { expect, it } from "vitest";
import { baselineMigrationDiagnostics } from "../../src/state/kv-store.js";
it("reports baseline migration",()=>expect(baselineMigrationDiagnostics({stateVersion:3})).toEqual(["migrated"]));
it("abandons unreconstructable pending intent explicitly",()=>expect(baselineMigrationDiagnostics({stateVersion:3,pending:true})).toEqual(["migrated","legacy_pending_abandoned"]));
