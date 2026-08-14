import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  completeDrive9Command,
  parseDrive9Command,
} from "../src/pi-extension-commands.js";

describe("Drive9 extension command parsing", () => {
  it("parses the supported command surface", () => {
    assert.deepEqual(parseDrive9Command(""), { command: "status" });
    assert.deepEqual(parseDrive9Command("status"), { command: "status" });
    assert.deepEqual(parseDrive9Command("setup"), { command: "setup" });
    assert.deepEqual(parseDrive9Command("setup /workspaces/demo"), {
      command: "setup",
      root: "/workspaces/demo",
    });
    assert.deepEqual(parseDrive9Command("  setup   /workspaces/team project  "), {
      command: "setup",
      root: "/workspaces/team project",
    });
    assert.deepEqual(parseDrive9Command("setup /one /two"), {
      command: "setup",
      root: "/one /two",
    });
    assert.deepEqual(parseDrive9Command("off"), { command: "disable" });
    assert.deepEqual(parseDrive9Command("verify"), { command: "verify", write: false });
    assert.deepEqual(parseDrive9Command("verify write"), { command: "verify", write: true });
  });

  it("rejects unknown or ambiguous arguments", () => {
    assert.throws(() => parseDrive9Command("unknown"), /Unknown Drive9 command/);
    assert.throws(() => parseDrive9Command("status extra"), /Usage/);
    assert.throws(() => parseDrive9Command("verify delete"), /Usage/);
  });

  it("completes top-level and verify commands", () => {
    assert.deepEqual(completeDrive9Command("set"), [{ value: "setup", label: "setup" }]);
    assert.deepEqual(completeDrive9Command("verify w"), [
      { value: "verify write", label: "verify write" },
    ]);
    assert.equal(completeDrive9Command("setup /workspaces"), null);
  });
});
