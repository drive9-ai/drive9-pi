import assert from "node:assert/strict";
import test from "node:test";
import { defaultDrive9Effect, drive9ReplayPolicy } from "../src/workspace/effect-policy.js";

test("unknown tools with an environment default to workspace plus external", () => {
  assert.equal(defaultDrive9Effect("third_party", true), "workspace+external");
  assert.equal(drive9ReplayPolicy("workspace+external"), "unsafe");
});

test("known deterministic workspace mutators are replay-safe only after recovery", () => {
  assert.equal(defaultDrive9Effect("write", true), "workspace");
  assert.equal(defaultDrive9Effect("edit", true), "workspace");
  assert.equal(drive9ReplayPolicy("workspace"), "safe");
});

test("read-only tools do not create workspace attempts", () => {
  assert.equal(defaultDrive9Effect("read", true), "none");
  assert.equal(defaultDrive9Effect("grep", true), "none");
});
