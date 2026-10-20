import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/chord";
import {
  Client,
  RuntimeBusyError,
  RuntimeCanceledError,
  RuntimeExecutionError,
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

const encoder = new TextEncoder();

function ctx(aborted = false): Context {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return { abortSignal: controller.signal } as unknown as Context;
}

type ExecCall = { request: ExecRequest; options: ExecOptions };

class FakeClient implements Drive9RuntimeExecClient {
  readonly calls: ExecCall[] = [];
  handler: (input: ExecRequest, options: ExecOptions) => Promise<ExecResult> = async () => result();

  async exec(input: ExecRequest, options: ExecOptions = {}): Promise<ExecResult> {
    this.calls.push({ request: input, options });
    return await this.handler(input, options);
  }
}

class FakeSpill implements RuntimeSpillSink {
  readonly appended: Uint8Array[] = [];
  createCalls = 0;
  appendCalls = 0;
  failCreate = false;
  failAppendAt: number | undefined;
  rejectAbortedContext = false;

  async create(context: Context): Promise<string> {
    this.createCalls++;
    if (this.rejectAbortedContext && context.abortSignal?.aborted) throw new Error("spill context aborted");
    if (this.failCreate) throw new Error("drive9 create rejected");
    return "/ws/.drive9-pi-tmp/runtime-exec-abc.log";
  }

  async append(_path: string, bytes: Uint8Array, context: Context): Promise<void> {
    this.appendCalls++;
    if (this.rejectAbortedContext && context.abortSignal?.aborted) throw new Error("spill context aborted");
    if (this.failAppendAt === this.appendCalls) throw new Error("drive9 append rejected");
    this.appended.push(bytes.slice());
  }

  bytes(): Uint8Array {
    const length = this.appended.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.appended) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined;
  }
}

function result(exitCode = 0): ExecResult {
  return { executionId: "execution-1", exitCode, durationMs: 1, sandbox: "warm" };
}

function makeExec(
  client: Drive9RuntimeExecClient,
  spill: RuntimeSpillSink,
  overrides?: { root?: string; currentCwd?: () => string },
) {
  return createDrive9RuntimeExec({
    client,
    root: overrides?.root ?? "/ws",
    currentCwd: overrides?.currentCwd ?? (() => "/ws"),
    spill,
  });
}

describe("Drive9RuntimeExec", () => {
  it("passes command/env through without splitting or leaking process.env", async () => {
    const client = new FakeClient();
    const exec = makeExec(client, new FakeSpill());
    process.env.DRIVE9_PI_HOST_ONLY_TEST = "must-not-leak";
    try {
      const r = await exec(
        "grep -r 'a b' . | wc -l > out.txt",
        { env: { EXPLICIT: "yes" }, inheritEnv: true },
        ctx(),
      );
      assert.ok(r.ok);
      assert.equal(client.calls[0]?.request.command, "grep -r 'a b' . | wc -l > out.txt");
      assert.equal(client.calls[0]?.request.argv, undefined);
      assert.deepEqual(client.calls[0]?.request.env, { EXPLICIT: "yes" });
      const passedEnv = client.calls[0]?.request.env as Record<string, string> | undefined;
      assert.equal(passedEnv?.["DRIVE9_PI_HOST_ONLY_TEST"], undefined);
      assert.deepEqual(client.calls[0]?.request.workspace, { root: "/ws" });
    } finally {
      delete process.env.DRIVE9_PI_HOST_ONLY_TEST;
    }
  });

  it("passes an empty command as a legal shell no-op", async () => {
    const client = new FakeClient();
    const r = await makeExec(client, new FakeSpill())("", undefined, ctx());
    assert.ok(r.ok);
    assert.equal(client.calls[0]?.request.command, "");
  });

  it("maps a NUL command rejected before start to spawn_error without retry", async () => {
    const client = new FakeClient();
    client.handler = async () => {
      throw new RuntimeStartError("invalid_request", "command contains NUL");
    };
    const r = await makeExec(client, new FakeSpill())("printf '\0'", undefined, ctx());
    assert.ok(!r.ok);
    assert.equal(r.error.code, "spawn_error");
    assert.equal(client.calls.length, 1);
  });

  it("returns aborted with zero network calls when pre-aborted", async () => {
    const client = new FakeClient();
    const r = await makeExec(client, new FakeSpill())("ls", undefined, ctx(true));
    assert.ok(!r.ok);
    assert.equal(r.error.code, "aborted");
    assert.equal(client.calls.length, 0);
  });

  describe("cwd", () => {
    it("reads the live environment cwd for every call", async () => {
      let cwd = "/ws";
      const client = new FakeClient();
      const exec = makeExec(client, new FakeSpill(), { currentCwd: () => cwd });
      assert.ok((await exec("pwd", undefined, ctx())).ok);
      cwd = "/ws/app";
      assert.ok((await exec("pwd", undefined, ctx())).ok);
      assert.ok((await exec("pwd", { cwd: "sub" }, ctx())).ok);
      assert.equal(client.calls[0]?.request.cwd, undefined);
      assert.equal(client.calls[1]?.request.cwd, "app");
      assert.equal(client.calls[2]?.request.cwd, "app/sub");
    });

    it("converts an absolute in-root cwd to root-relative", async () => {
      const client = new FakeClient();
      const r = await makeExec(client, new FakeSpill())("ls", { cwd: "/ws/app/sub" }, ctx());
      assert.ok(r.ok);
      assert.equal(client.calls[0]?.request.cwd, "app/sub");
    });

    it("rejects a root escape before the network call", async () => {
      const client = new FakeClient();
      const r = await makeExec(client, new FakeSpill())("ls", { cwd: "/ws/../etc" }, ctx());
      assert.ok(!r.ok);
      assert.equal(r.error.code, "spawn_error");
      assert.equal(client.calls.length, 0);
    });
  });

  describe("option validation", () => {
    it("ceil-converts seconds to integer milliseconds", async () => {
      const client = new FakeClient();
      const r = await makeExec(client, new FakeSpill())("ls", { timeout: 0.0001 }, ctx());
      assert.ok(r.ok);
      assert.equal(client.calls[0]?.request.timeout_ms, 1);
    });

    for (const bad of [0, -1, 3_000_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      it(`rejects invalid timeout ${bad} without a network call`, async () => {
        const client = new FakeClient();
        const r = await makeExec(client, new FakeSpill())("ls", { timeout: bad }, ctx());
        assert.ok(!r.ok);
        assert.equal(r.error.code, "timeout");
        assert.equal(client.calls.length, 0);
      });
    }

    it("rejects inheritEnv:false without a network call", async () => {
      const client = new FakeClient();
      const r = await makeExec(client, new FakeSpill())("ls", { inheritEnv: false }, ctx());
      assert.ok(!r.ok);
      assert.equal(r.error.code, "spawn_error");
      assert.equal(client.calls.length, 0);
    });

    for (const field of ["afterBytes", "afterLines"] as const) {
      for (const bad of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        it(`rejects invalid spill ${field}=${bad} without a network call`, async () => {
          const client = new FakeClient();
          const spill = { afterBytes: 10, afterLines: 10, [field]: bad };
          const r = await makeExec(client, new FakeSpill())("ls", { spill }, ctx());
          assert.ok(!r.ok);
          assert.equal(r.error.code, "spawn_error");
          assert.equal(client.calls.length, 0);
        });
      }
    }
  });

  describe("complete raw spill", () => {
    it("writes threshold prefix plus all later chunks in Runtime arrival order", async () => {
      const client = new FakeClient();
      const spill = new FakeSpill();
      client.handler = async (_input, options) => {
        await options.onStdout?.(encoder.encode("ab"));
        await options.onStderr?.(encoder.encode("c\n"));
        await options.onStdout?.(encoder.encode("def"));
        return result();
      };
      const r = await makeExec(client, spill)(
        "big",
        { spill: { afterBytes: 4, afterLines: 1_000_000 } },
        ctx(),
      );
      assert.ok(r.ok);
      assert.equal(r.value.spillPath, "/ws/.drive9-pi-tmp/runtime-exec-abc.log");
      assert.equal(new TextDecoder().decode(spill.bytes()), "abc\ndef");
      assert.equal(spill.createCalls, 1);
      assert.equal(spill.appendCalls, 1, "small frames must be coalesced into one terminal append");
    });

    it("spills when complete-or-partial line count crosses afterLines", async () => {
      const client = new FakeClient();
      const spill = new FakeSpill();
      client.handler = async (_input, options) => {
        await options.onStdout?.(encoder.encode("one"));
        await options.onStderr?.(encoder.encode(" two\n"));
        await options.onStdout?.(encoder.encode("three"));
        return result();
      };
      const r = await makeExec(client, spill)(
        "lines",
        { spill: { afterBytes: Number.MAX_SAFE_INTEGER, afterLines: 1 } },
        ctx(),
      );
      assert.ok(r.ok);
      assert.equal(new TextDecoder().decode(spill.bytes()), "one two\nthree");
    });

    it("counts a partial line when afterLines is zero", async () => {
      const client = new FakeClient();
      const spill = new FakeSpill();
      client.handler = async (_input, options) => {
        await options.onStdout?.(encoder.encode("partial"));
        return result();
      };
      const r = await makeExec(client, spill)(
        "partial",
        { spill: { afterBytes: Number.MAX_SAFE_INTEGER, afterLines: 0 } },
        ctx(),
      );
      assert.ok(r.ok);
      assert.equal(new TextDecoder().decode(spill.bytes()), "partial");
    });

    it("create failure rejects the SDK callback, causes cancel/unknown, and stops later output", async () => {
      const client = new FakeClient();
      const spill = new FakeSpill();
      spill.failCreate = true;
      let cancelAttempts = 0;
      let laterCallbackRan = false;
      let outputCalls = 0;
      client.handler = async (_input, options) => {
        try {
          await options.onStdout?.(encoder.encode("first"));
          laterCallbackRan = true;
          await options.onStderr?.(encoder.encode("second"));
          return result();
        } catch (error) {
          // This is the #1022 SDK contract: a frame callback failure triggers
          // a best-effort cancel and is surfaced as outcome_unknown.
          cancelAttempts++;
          throw new RuntimeOutcomeUnknownError("runtime stdout callback failed", "execution-1", error);
        }
      };
      const r = await makeExec(client, spill)(
        "big",
        {
          onOutput: () => outputCalls++,
          spill: { afterBytes: 0, afterLines: 0 },
        },
        ctx(),
      );
      assert.ok(!r.ok);
      assert.equal(r.error.code, "unknown");
      assert.equal(r.error.spillPath, undefined);
      assert.equal(cancelAttempts, 1);
      assert.equal(laterCallbackRan, false);
      assert.equal(outputCalls, 0);
    });

    it("full-batch append failure rejects the SDK callback and causes cancel/unknown", async () => {
      const client = new FakeClient();
      const spill = new FakeSpill();
      spill.failAppendAt = 1;
      let cancelAttempts = 0;
      let laterCallbackRan = false;
      client.handler = async (_input, options) => {
        try {
          await options.onStdout?.(new Uint8Array(8 * 1024 * 1024));
          laterCallbackRan = true;
          return result();
        } catch (error) {
          cancelAttempts++;
          throw new RuntimeOutcomeUnknownError("runtime stdout callback failed", "execution-1", error);
        }
      };
      const r = await makeExec(client, spill)(
        "big",
        { spill: { afterBytes: 0, afterLines: Number.MAX_SAFE_INTEGER } },
        ctx(),
      );
      assert.ok(!r.ok);
      assert.equal(r.error.code, "unknown");
      assert.equal(r.error.spillPath, undefined);
      assert.equal(cancelAttempts, 1);
      assert.equal(laterCallbackRan, false);
    });

    it("coalesces tens of MiB of small frames into aligned 8 MiB appends plus one tail", async () => {
      const client = new FakeClient();
      const spill = new FakeSpill();
      const frame = new Uint8Array(64 * 1024).fill(0x61);
      const frameCount = 512; // 32 MiB total before the final tail.
      const tail = encoder.encode("tail");
      client.handler = async (_input, options) => {
        for (let index = 0; index < frameCount; index++) await options.onStdout?.(frame);
        await options.onStderr?.(tail);
        return result();
      };
      const r = await makeExec(client, spill)(
        "large-output",
        { spill: { afterBytes: 0, afterLines: Number.MAX_SAFE_INTEGER } },
        ctx(),
      );
      assert.ok(r.ok);
      assert.equal(spill.createCalls, 1);
      assert.equal(spill.appendCalls, 5, "512 Runtime frames must not become 512 Drive9 appends");
      assert.deepEqual(spill.appended.map((part) => part.byteLength), [
        8 * 1024 * 1024,
        8 * 1024 * 1024,
        8 * 1024 * 1024,
        8 * 1024 * 1024,
        tail.byteLength,
      ]);
      assert.equal(
        spill.appended.reduce((total, part) => total + part.byteLength, 0),
        frameCount * frame.byteLength + tail.byteLength,
      );
      assert.equal(new TextDecoder().decode(spill.appended.at(-1)), "tail");
    });

    it("maps a final partial-batch append failure after terminal to unknown without publishing spillPath", async () => {
      const client = new FakeClient();
      const spill = new FakeSpill();
      spill.failAppendAt = 1;
      client.handler = async (_input, options) => {
        await options.onStdout?.(encoder.encode("short"));
        return result();
      };
      const r = await makeExec(client, spill)(
        "short-output",
        { spill: { afterBytes: 0, afterLines: Number.MAX_SAFE_INTEGER } },
        ctx(),
      );
      assert.ok(!r.ok);
      assert.equal(r.error.code, "unknown");
      assert.equal(r.error.spillPath, undefined);
      assert.equal(spill.appendCalls, 1);
    });

    it("propagates a spill failure through the real SDK callback-cancel path", async () => {
      let cancelAttempts = 0;
      const server = createServer((request, response) => {
        if (request.method === "POST" && request.url === "/v1/runtime/exec") {
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          response.end([
            JSON.stringify({
              type: "started",
              execution_id: "execution-1",
              cwd: "/workspace/ws",
              sandbox: "new",
            }),
            JSON.stringify({
              type: "stdout",
              execution_id: "execution-1",
              data_base64: Buffer.from("first").toString("base64"),
            }),
            JSON.stringify({
              type: "stderr",
              execution_id: "execution-1",
              data_base64: Buffer.from("must-not-be-delivered").toString("base64"),
            }),
            JSON.stringify({
              type: "exit",
              execution_id: "execution-1",
              exit_code: 0,
              duration_ms: 1,
            }),
            "",
          ].join("\n"));
          return;
        }
        if (request.method === "POST" && request.url === "/v1/runtime/executions/execution-1/cancel") {
          cancelAttempts++;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ canceled: true }));
          return;
        }
        response.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as AddressInfo;
      const client = new Client(`http://127.0.0.1:${address.port}`, "test-key");
      const spill = new FakeSpill();
      spill.failCreate = true;
      let outputCalls = 0;
      try {
        const r = await makeExec(client, spill)(
          "big",
          {
            onOutput: () => outputCalls++,
            spill: { afterBytes: 0, afterLines: 0 },
          },
          ctx(),
        );
        assert.ok(!r.ok);
        assert.equal(r.error.code, "unknown");
        assert.equal(r.error.spillPath, undefined);
        assert.equal(cancelAttempts, 1);
        assert.equal(outputCalls, 0);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error === undefined ? resolve() : reject(error));
        });
      }
    });
  });

  it("uses independent decoders and preserves raw interleaved bytes", async () => {
    const client = new FakeClient();
    const spill = new FakeSpill();
    const chunks: string[] = [];
    client.handler = async (_input, options) => {
      await options.onStdout?.(new Uint8Array([0xe4, 0xb8]));
      await options.onStderr?.(encoder.encode("E"));
      await options.onStdout?.(new Uint8Array([0xad]));
      return result();
    };
    const r = await makeExec(client, spill)(
      "x",
      {
        onOutput: (text) => chunks.push(text),
        spill: { afterBytes: 0, afterLines: Number.MAX_SAFE_INTEGER },
      },
      ctx(),
    );
    assert.ok(r.ok);
    assert.deepEqual(chunks, ["E", "中"]);
    assert.deepEqual([...spill.bytes()], [0xe4, 0xb8, 0x45, 0xad]);
  });

  describe("terminal and callback behavior", () => {
    it("maps a streaming onOutput throw to unknown after SDK cancel", async () => {
      const client = new FakeClient();
      let cancelAttempts = 0;
      client.handler = async (_input, options) => {
        try {
          await options.onStdout?.(encoder.encode("x"));
          return result();
        } catch (error) {
          cancelAttempts++;
          throw new RuntimeOutcomeUnknownError("runtime stdout callback failed", "execution-1", error);
        }
      };
      const r = await makeExec(client, new FakeSpill())(
        "x",
        { onOutput: () => { throw new Error("consumer failed"); } },
        ctx(),
      );
      assert.ok(!r.ok);
      assert.equal(r.error.code, "unknown");
      assert.equal(cancelAttempts, 1);
    });

    it("maps an onOutput throw during successful terminal decoder flush to callback_error", async () => {
      const client = new FakeClient();
      client.handler = async (_input, options) => {
        await options.onStdout?.(new Uint8Array([0xe4, 0xb8]));
        return result();
      };
      const r = await makeExec(client, new FakeSpill())(
        "x",
        { onOutput: () => { throw new Error("flush consumer failed"); } },
        ctx(),
      );
      assert.ok(!r.ok);
      assert.equal(r.error.code, "callback_error");
      assert.equal(r.error.spillPath, undefined);
    });

    for (const [name, terminal] of [
      ["timeout", new RuntimeTimeoutError("timed out", "execution-1")],
      ["canceled", new RuntimeCanceledError("canceled", "execution-1")],
    ] as const) {
      it(`flushes pending decoder state before mapping ${name}`, async () => {
        const client = new FakeClient();
        const output: string[] = [];
        client.handler = async (_input, options) => {
          await options.onStdout?.(new Uint8Array([0xe4, 0xb8]));
          throw terminal;
        };
        const r = await makeExec(client, new FakeSpill())(
          "x",
          { onOutput: (text) => output.push(text) },
          ctx(),
        );
        assert.ok(!r.ok);
        assert.equal(r.error.code, name === "timeout" ? "timeout" : "aborted");
        assert.deepEqual(output, ["�"]);
      });
    }

    it("flushes a confirmed cancel tail with an abort-detached spill context", async () => {
      const controller = new AbortController();
      const context = {
        abortSignal: controller.signal,
        value: () => undefined,
        toString: () => "test context",
      } as Context;
      const client = new FakeClient();
      const spill = new FakeSpill();
      spill.rejectAbortedContext = true;
      client.handler = async (_input, options) => {
        await options.onStdout?.(encoder.encode("captured-before-cancel"));
        controller.abort();
        throw new RuntimeCanceledError("canceled", "execution-1");
      };
      const r = await makeExec(client, spill)(
        "x",
        { spill: { afterBytes: 0, afterLines: Number.MAX_SAFE_INTEGER } },
        context,
      );
      assert.ok(!r.ok);
      assert.equal(r.error.code, "aborted");
      assert.equal(r.error.spillPath, "/ws/.drive9-pi-tmp/runtime-exec-abc.log");
      assert.equal(new TextDecoder().decode(spill.bytes()), "captured-before-cancel");
    });
  });

  describe("error mapping and spillPath scope", () => {
    const cases: Array<[string, Error, string]> = [
      ["canceled", new RuntimeCanceledError("c", "execution-1"), "aborted"],
      ["timeout", new RuntimeTimeoutError("t", "execution-1"), "timeout"],
      ["not-enabled", new RuntimeNotEnabledError(), "shell_unavailable"],
      ["start", new RuntimeStartError("bad_request", "s", "execution-1"), "spawn_error"],
      ["busy", new RuntimeBusyError("busy", 100), "spawn_error"],
      ["outcome-unknown", new RuntimeOutcomeUnknownError("u", "execution-1"), "unknown"],
    ];

    for (const [name, thrown, code] of cases) {
      it(`${name} → ${code} with zero retry`, async () => {
        const client = new FakeClient();
        client.handler = async () => { throw thrown; };
        const r = await makeExec(client, new FakeSpill())("ls", undefined, ctx());
        assert.ok(!r.ok);
        assert.equal(r.error.code, code);
        assert.equal(client.calls.length, 1);
      });
    }

    it("maps a generic runtime/protocol failure to unknown", async () => {
      const client = new FakeClient();
      client.handler = async () => { throw new Error("socket hangup"); };
      const r = await makeExec(client, new FakeSpill())("ls", undefined, ctx());
      assert.ok(!r.ok);
      assert.equal(r.error.code, "unknown");
    });

    it("maps an unclassified terminal RuntimeExecutionError to unknown", async () => {
      const client = new FakeClient();
      client.handler = async () => {
        throw new RuntimeExecutionError("provider_failed", "provider terminal failure", "execution-1");
      };
      const r = await makeExec(client, new FakeSpill())("ls", undefined, ctx());
      assert.ok(!r.ok);
      assert.equal(r.error.code, "unknown");
      assert.equal(client.calls.length, 1);
    });

    for (const [name, thrown, code, carriesSpill] of [
      ["canceled", new RuntimeCanceledError("c", "execution-1"), "aborted", true],
      ["timeout", new RuntimeTimeoutError("t", "execution-1"), "timeout", true],
      ["unknown", new RuntimeOutcomeUnknownError("u", "execution-1"), "unknown", false],
    ] as const) {
      it(`${name} ${carriesSpill ? "carries" : "does not carry"} a completed prefix spill`, async () => {
        const client = new FakeClient();
        client.handler = async (_input, options) => {
          await options.onStdout?.(encoder.encode("output"));
          throw thrown;
        };
        const r = await makeExec(client, new FakeSpill())(
          "x",
          { spill: { afterBytes: 0, afterLines: 0 } },
          ctx(),
        );
        assert.ok(!r.ok);
        assert.equal(r.error.code, code);
        assert.equal(r.error.spillPath !== undefined, carriesSpill);
      });
    }
  });
});
