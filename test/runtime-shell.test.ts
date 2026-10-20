import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/chord";
import {
  RuntimeBusyError,
  RuntimeCanceledError,
  RuntimeNotEnabledError,
  RuntimeOutcomeUnknownError,
  RuntimeStartError,
  RuntimeTimeoutError,
  type ExecOptions,
  type ExecRequest,
  type ExecResult,
} from "drive9";
import {
  createDrive9RuntimeExec,
  type Drive9RuntimeExecClient,
  type RuntimeSpillSink,
} from "../src/environment/runtime-shell.js";

function ctx(aborted = false): Context {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return { abortSignal: controller.signal } as unknown as Context;
}

type ExecCall = { request: ExecRequest; options: ExecOptions };

/** Records calls; by default returns exit 0. Behavior overridable per test. */
class FakeClient implements Drive9RuntimeExecClient {
  readonly calls: ExecCall[] = [];
  handler: (input: ExecRequest, options: ExecOptions) => Promise<ExecResult> = async () => ({
    executionId: "e1",
    exitCode: 0,
    durationMs: 1,
    sandbox: "warm",
  });
  async exec(input: ExecRequest, options: ExecOptions = {}): Promise<ExecResult> {
    this.calls.push({ request: input, options });
    return await this.handler(input, options);
  }
}

class FakeSpill implements RuntimeSpillSink {
  readonly appended: Uint8Array[] = [];
  created = false;
  failAppend = false;
  async create(): Promise<string> {
    this.created = true;
    return "/ws/.drive9-pi-tmp/runtime-exec-abc.log";
  }
  async append(_path: string, bytes: Uint8Array): Promise<void> {
    if (this.failAppend) throw new Error("drive9 append rejected");
    this.appended.push(bytes);
  }
}

function makeExec(client: Drive9RuntimeExecClient, spill: RuntimeSpillSink, overrides?: { root?: string; cwd?: string }) {
  return createDrive9RuntimeExec({
    client,
    root: overrides?.root ?? "/ws",
    cwd: overrides?.cwd ?? "/ws",
    spill,
  });
}

describe("Drive9RuntimeExec", () => {
  it("passes the command through as SDK `command`, never self-splitting", async () => {
    const client = new FakeClient();
    const exec = makeExec(client, new FakeSpill());
    const r = await exec("grep -r 'a b' . | wc -l > out.txt", undefined, ctx());
    assert.ok(r.ok);
    assert.equal(client.calls[0]?.request.command, "grep -r 'a b' . | wc -l > out.txt");
    assert.equal(client.calls[0]?.request.argv, undefined);
    assert.deepEqual(client.calls[0]?.request.workspace, { root: "/ws" });
  });

  it("empty command is a legal no-op passed through, not an error", async () => {
    const client = new FakeClient();
    const exec = makeExec(client, new FakeSpill());
    const r = await exec("", undefined, ctx());
    assert.ok(r.ok);
    assert.equal(client.calls[0]?.request.command, "");
  });

  it("returns aborted with ZERO network call when context is pre-aborted", async () => {
    const client = new FakeClient();
    const exec = makeExec(client, new FakeSpill());
    const r = await exec("ls", undefined, ctx(true));
    assert.ok(!r.ok);
    assert.equal(r.error.code, "aborted");
    assert.equal(client.calls.length, 0);
  });

  describe("cwd", () => {
    it("undefined cwd runs at root (no cwd field)", async () => {
      const client = new FakeClient();
      const r = await makeExec(client, new FakeSpill())("ls", undefined, ctx());
      assert.ok(r.ok);
      assert.equal(client.calls[0]?.request.cwd, undefined);
    });
    it("absolute cwd inside root → root-relative", async () => {
      const client = new FakeClient();
      const r = await makeExec(client, new FakeSpill())("ls", { cwd: "/ws/app/sub" }, ctx());
      assert.ok(r.ok);
      assert.equal(client.calls[0]?.request.cwd, "app/sub");
    });
    it("relative cwd resolves against env cwd", async () => {
      const client = new FakeClient();
      const exec = makeExec(client, new FakeSpill(), { cwd: "/ws/app" });
      const r = await exec("ls", { cwd: "sub" }, ctx());
      assert.ok(r.ok);
      assert.equal(client.calls[0]?.request.cwd, "app/sub");
    });
    it("`..` escape outside root → spawn_error, zero network", async () => {
      const client = new FakeClient();
      const r = await makeExec(client, new FakeSpill())("ls", { cwd: "/ws/../etc" }, ctx());
      assert.ok(!r.ok);
      assert.equal(r.error.code, "spawn_error");
      assert.equal(client.calls.length, 0);
    });
  });

  describe("timeout", () => {
    it("seconds → ceil ms", async () => {
      const client = new FakeClient();
      const r = await makeExec(client, new FakeSpill())("ls", { timeout: 0.0001 }, ctx());
      assert.ok(r.ok);
      assert.equal(client.calls[0]?.request.timeout_ms, 1);
    });
    it("over-max is REJECTED, not clamped; zero network", async () => {
      const client = new FakeClient();
      const r = await makeExec(client, new FakeSpill())("ls", { timeout: 3_000_000 }, ctx());
      assert.ok(!r.ok);
      assert.equal(r.error.code, "timeout");
      assert.equal(client.calls.length, 0);
    });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      it(`invalid timeout ${bad} → timeout, zero network`, async () => {
        const client = new FakeClient();
        const r = await makeExec(client, new FakeSpill())("ls", { timeout: bad }, ctx());
        assert.ok(!r.ok);
        assert.equal(r.error.code, "timeout");
        assert.equal(client.calls.length, 0);
      });
    }
  });

  it("inheritEnv:false → spawn_error, zero network (no host env leak)", async () => {
    const client = new FakeClient();
    const r = await makeExec(client, new FakeSpill())("ls", { inheritEnv: false }, ctx());
    assert.ok(!r.ok);
    assert.equal(r.error.code, "spawn_error");
    assert.equal(client.calls.length, 0);
  });

  for (const bad of [1e20, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`invalid spill threshold ${bad} → spawn_error, zero network`, async () => {
      const client = new FakeClient();
      const r = await makeExec(client, new FakeSpill())("ls", { spill: { afterBytes: bad, afterLines: 0 } }, ctx());
      assert.ok(!r.ok);
      assert.equal(r.error.code, "spawn_error");
      assert.equal(client.calls.length, 0);
    });
  }

  describe("error mapping (fail-closed, zero-retry)", () => {
    const cases: Array<[string, Error, string, boolean]> = [
      ["canceled→aborted", new RuntimeCanceledError("c", "e1"), "aborted", true],
      ["timeout→timeout", new RuntimeTimeoutError("t", "e1"), "timeout", true],
      ["not-enabled→shell_unavailable", new RuntimeNotEnabledError(), "shell_unavailable", false],
      ["start→spawn_error", new RuntimeStartError("bad_request", "s", "e1"), "spawn_error", false],
      ["busy→spawn_error", new RuntimeBusyError("busy", 100), "spawn_error", false],
      ["outcome-unknown→unknown", new RuntimeOutcomeUnknownError("u", "e1"), "unknown", false],
    ];
    for (const [name, thrown, code] of cases) {
      it(name, async () => {
        const client = new FakeClient();
        client.handler = async () => {
          throw thrown;
        };
        const r = await makeExec(client, new FakeSpill())("ls", undefined, ctx());
        assert.ok(!r.ok);
        assert.equal(r.error.code, code);
        assert.equal(client.calls.length, 1, "no retry");
      });
    }
    it("generic runtime/protocol error → unknown (not spawn-safe)", async () => {
      const client = new FakeClient();
      client.handler = async () => {
        throw new Error("socket hangup");
      };
      const r = await makeExec(client, new FakeSpill())("ls", undefined, ctx());
      assert.ok(!r.ok);
      assert.equal(r.error.code, "unknown");
    });
  });

  it("spill-write failure → unknown (no degrade, no success)", async () => {
    const client = new FakeClient();
    const spill = new FakeSpill();
    spill.failAppend = true;
    client.handler = async (_input, options) => {
      await options.onStdout?.(new Uint8Array(200));
      return { executionId: "e1", exitCode: 0, durationMs: 1, sandbox: "warm" };
    };
    const r = await makeExec(client, spill)("big", { spill: { afterBytes: 10, afterLines: 1_000_000 } }, ctx());
    assert.ok(!r.ok);
    assert.equal(r.error.code, "unknown");
  });

  it("spills complete output to the Drive9 tempRoot and returns spillPath on success", async () => {
    const client = new FakeClient();
    const spill = new FakeSpill();
    client.handler = async (_input, options) => {
      await options.onStdout?.(new TextEncoder().encode("x".repeat(50)));
      return { executionId: "e1", exitCode: 0, durationMs: 1, sandbox: "warm" };
    };
    const r = await makeExec(client, spill)("big", { spill: { afterBytes: 10, afterLines: 1_000_000 } }, ctx());
    assert.ok(r.ok);
    assert.equal(r.value.spillPath, "/ws/.drive9-pi-tmp/runtime-exec-abc.log");
    assert.ok(spill.created);
  });

  it("decodes each stream with its own UTF-8 decoder (no mid-codepoint corruption on interleave)", async () => {
    // "中" = e4 b8 ad. Split across two stdout chunks, with a stderr frame interleaved.
    const client = new FakeClient();
    const chunks: string[] = [];
    client.handler = async (_input, options) => {
      await options.onStdout?.(new Uint8Array([0xe4, 0xb8]));
      await options.onStderr?.(new TextEncoder().encode("E"));
      await options.onStdout?.(new Uint8Array([0xad]));
      return { executionId: "e1", exitCode: 0, durationMs: 1, sandbox: "warm" };
    };
    const r = await makeExec(client, new FakeSpill())("x", {
      onOutput: (text: string) => chunks.push(text),
    }, ctx());
    assert.ok(r.ok);
    // The interleaved stderr "E" must not appear inside the multibyte char, and
    // "中" must be emitted whole (never a replacement char).
    assert.ok(chunks.includes("中"), `expected 中 whole, got ${JSON.stringify(chunks)}`);
    assert.ok(!chunks.join("").includes("�"), "no replacement char");
    assert.ok(chunks.includes("E"));
  });
});
