import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Drive9DurableFileSystemClient } from "../src/drive9-durable-file-system.js";
import { Drive9SdkExecutionEnv } from "../src/environment/sdk-environment.js";

const ctx = (signal?: AbortSignal): Context => ({
  abortSignal: signal,
  value: () => undefined,
  toString: () => "test-ctx",
});

function unusedClient(): Drive9DurableFileSystemClient {
  const unexpected = (): never => {
    throw new Error("unexpected Drive9 client call");
  };
  return {
    read: async () => unexpected(),
    write: async () => unexpected(),
    append: async () => unexpected(),
    list: async () => unexpected(),
    stat: async () => unexpected(),
    rename: async () => unexpected(),
    mkdir: async () => unexpected(),
    deleteFile: async () => unexpected(),
    deleteDir: async () => unexpected(),
    removeAll: async () => unexpected(),
  };
}

describe("Drive9SdkExecutionEnv", () => {
  it("uses the Drive9 filesystem namespace and never falls through to a host shell", async () => {
    const environment: ExecutionEnv = new Drive9SdkExecutionEnv({
      client: unusedClient(),
      root: "/workspaces/project",
      cwd: "/workspaces/project/src",
      id: "drive9:server:tenant:workspace",
    });
    let outputCalled = false;

    assert.equal(environment.id, "drive9:server:tenant:workspace");
    assert.equal(environment.cwd, "/workspaces/project/src");
    assert.deepEqual(await environment.absolutePath("index.ts", ctx()), {
      ok: true,
      value: "/workspaces/project/src/index.ts",
    });

    const executed = await environment.exec(
      "touch /tmp/should-not-exist",
      {
        cwd: "/tmp",
        inheritEnv: true,
        env: { SECRET: "must-not-reach-a-process" },
        onOutput: () => {
          outputCalled = true;
        },
      },
      ctx(),
    );

    assert.equal(executed.ok, false);
    if (executed.ok) return;
    assert.equal(executed.error.code, "shell_unavailable");
    assert.equal(outputCalled, false);
  });

  it("preserves cancellation precedence without invoking Drive9 or a shell", async () => {
    const controller = new AbortController();
    controller.abort();
    const environment = new Drive9SdkExecutionEnv({
      client: unusedClient(),
      root: "/workspaces/project",
    });

    const executed = await environment.exec("ignored", undefined, ctx(controller.signal));

    assert.equal(executed.ok, false);
    if (executed.ok) return;
    assert.equal(executed.error.code, "aborted");
  });
});
