import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/chord";
import type {
  PromptInput,
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  createDrive9DurableExtension,
  DRIVE9_DURABLE_EXTENSION_NAME,
} from "../src/extension/durable-extension.js";
import type { WorkspaceMutationCoordinator } from "../src/workspace/types.js";

const coordinator = {
  prepare: async () => {
    throw new Error("not executed");
  },
  checkpointAndVerify: async () => {
    throw new Error("not executed");
  },
  invalidate: () => undefined,
  poison: async (error: Error) => {
    throw error;
  },
} satisfies WorkspaceMutationCoordinator;

function tool(name: string): ToolRegistration {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async (_args: unknown, _api: ToolExecutionApi, _context: Context) => ({ content: [] }),
  } as unknown as ToolRegistration;
}

test("wraps Pi native mutators without registering duplicate tool implementations", () => {
  const extension = createDrive9DurableExtension({ coordinator });
  assert.equal(extension.name, DRIVE9_DURABLE_EXTENSION_NAME);
  assert.equal(extension.tools, undefined);
  assert.deepEqual(extension.wraps?.map((wrap) => ("tool" in wrap ? wrap.tool : undefined)), [
    "write",
    "edit",
    "bash",
  ]);

  const writeWrap = extension.wraps?.find((wrap) => "tool" in wrap && wrap.tool === "write");
  const bashWrap = extension.wraps?.find((wrap) => "tool" in wrap && wrap.tool === "bash");
  assert.ok(writeWrap !== undefined && "tool" in writeWrap);
  assert.ok(bashWrap !== undefined && "tool" in bashWrap);
  const write = writeWrap.wrap(tool("write"));
  const bash = bashWrap.wrap(tool("bash"));
  assert.equal(write.name, "write");
  assert.equal(write.executionMode, "sequential");
  assert.equal(write.replay, "safe");
  assert.equal(bash.name, "bash");
  assert.equal(bash.executionMode, "sequential");
  assert.equal(bash.replay, "unsafe");
});

test("renders only a small runtime-semantic prompt for an active environment", async () => {
  const extension = createDrive9DurableExtension({ coordinator });
  const prompt = extension.sections?.[0];
  assert.equal(prompt?.key, "drive9-workspace");
  const withoutEnvironment = await prompt?.render({ env: undefined } as PromptInput, {} as Context);
  assert.equal(withoutEnvironment, undefined);
  const rendered = await prompt?.render(
    { env: { id: "drive9-layer:one" } as ExecutionEnv } as PromptInput,
    {} as Context,
  );
  assert.match(rendered ?? "", /durable Drive9 workspace/);
  assert.doesNotMatch(rendered ?? "", /CAS|LayerFS|candidate|writer epoch/);
});

test("prompt integration can be disabled without changing wrappers", () => {
  const extension = createDrive9DurableExtension({ coordinator, prompt: false });
  assert.equal(extension.sections, undefined);
  assert.equal(extension.wraps?.length, 3);
});
