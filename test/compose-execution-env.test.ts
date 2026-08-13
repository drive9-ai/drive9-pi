import assert from "node:assert/strict";
import { posix } from "node:path";
import { describe, it } from "node:test";
import {
  err,
  ExecutionError,
  FileError,
  type FileInfo,
  type FileSystem,
  ok,
  type Shell,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { composeExecutionEnv } from "../src/compose-execution-env.js";

function fakeFileSystem(events: string[]): FileSystem {
  const info: FileInfo = { name: "workspace", path: "/workspace", kind: "directory", size: 0, mtimeMs: 0 };
  const fileSystem: FileSystem = {
    cwd: "/workspace",
    absolutePath: async (path) => ok(posix.isAbsolute(path) ? posix.normalize(path) : posix.resolve(fileSystem.cwd, path)),
    joinPath: async (parts) => ok(`/workspace/${parts.join("/")}`),
    readTextFile: async () => ok("text"),
    readTextLines: async () => ok(["text"]),
    readBinaryFile: async () => ok(Buffer.from("text")),
    writeFile: async () => ok(undefined),
    appendFile: async () => ok(undefined),
    renameFile: async () => ok(undefined),
    fileInfo: async () => ok(info),
    listDir: async () => ok([]),
    canonicalPath: async () => ok("/workspace"),
    exists: async () => ok(true),
    createDir: async () => ok(undefined),
    remove: async () => ok(undefined),
    createTempDir: async () => ok("/workspace/temp"),
    createTempFile: async () => ok("/workspace/temp-file"),
    cleanup: async () => {
      events.push("filesystem-cleanup");
    },
  };
  return fileSystem;
}

class RecordingShell implements Shell {
  readonly calls: Array<{ command: string; options?: ShellExecOptions }> = [];

  constructor(private readonly events: string[]) {}

  async exec(command: string, options?: ShellExecOptions): ReturnType<Shell["exec"]> {
    this.calls.push({ command, ...(options === undefined ? {} : { options }) });
    return ok({ stdout: "caller-shell", stderr: "", exitCode: 0 });
  }

  async cleanup(): Promise<void> {
    this.events.push("shell-cleanup");
  }
}

describe("composeExecutionEnv", () => {
  it("delegates filesystem and execution to the exact supplied providers", async () => {
    const events: string[] = [];
    const fileSystem = fakeFileSystem(events);
    const shell = new RecordingShell(events);
    const environment = composeExecutionEnv({ fileSystem, shell });

    environment.cwd = "/workspace/subdir";
    assert.equal(fileSystem.cwd, "/workspace/subdir");
    assert.equal((await environment.readTextFile("file.txt")).ok, true);
    const execution = await environment.exec("customer-command", { timeout: 12 });
    assert.deepEqual(execution, ok({ stdout: "caller-shell", stderr: "", exitCode: 0 }));
    assert.deepEqual(shell.calls, [
      { command: "customer-command", options: { timeout: 12, cwd: "/workspace/subdir" } },
    ]);

    await environment.exec("relative-command", { cwd: "../other" });
    assert.deepEqual(shell.calls[1], {
      command: "relative-command",
      options: { cwd: "/workspace/other" },
    });

    await environment.cleanup();
    assert.deepEqual(events.sort(), ["filesystem-cleanup", "shell-cleanup"]);
  });

  it("requires an explicit shell instead of falling back to a host process", () => {
    const fileSystem = fakeFileSystem([]);
    assert.throws(
      () => composeExecutionEnv({ fileSystem, shell: undefined as unknown as Shell }),
      /explicit fileSystem and shell providers/,
    );
  });

  it("does not replace caller shell errors", async () => {
    const shell: Shell = {
      exec: async () => ({ ok: false, error: new ExecutionError("shell_unavailable", "sandbox owns shell") }),
      cleanup: async () => {},
    };
    const result = await composeExecutionEnv({ fileSystem: fakeFileSystem([]), shell }).exec("command");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "shell_unavailable");
  });

  it("does not call the shell when the filesystem rejects the execution cwd", async () => {
    const fileSystem = fakeFileSystem([]);
    fileSystem.absolutePath = async () => err(new FileError("permission_denied", "outside workspace"));
    const shell = new RecordingShell([]);

    const result = await composeExecutionEnv({ fileSystem, shell }).exec("command", { cwd: "../outside" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "spawn_error");
    assert.equal(shell.calls.length, 0);
  });
});
