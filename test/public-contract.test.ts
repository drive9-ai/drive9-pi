import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as packageExports from "../src/index.js";

describe("public package contract", () => {
  it("exports SDK filesystem and evidence capabilities without an execution implementation", () => {
    assert.equal(typeof packageExports.Drive9FileSystem, "function");
    assert.equal(typeof packageExports.composeExecutionEnv, "function");
    assert.equal(typeof packageExports.PersistentToolResultStore, "function");
    assert.equal("Drive9ExecutionEnv" in packageExports, false);
    assert.equal("createDrive9ExecTool" in packageExports, false);
    assert.equal("createDrive9MountDrain" in packageExports, false);
  });
});
