import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getOrThrow } from "@earendil-works/pi-agent-core";
import { Drive9ExecutionEnv } from "../src/index.js";

const environments: Drive9ExecutionEnv[] = [];
const testRoots: string[] = [];

async function createTestRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  testRoots.push(root);
  return root;
}

async function createEnvironment(options?: {
  cwd?: string;
  tempRoot?: string;
  env?: Record<string, string>;
}): Promise<{ env: Drive9ExecutionEnv; workspaceRoot: string; outsideRoot: string }> {
  const container = await createTestRoot("drive9-pi-env-");
  const workspaceRoot = join(container, "workspace");
  const outsideRoot = join(container, "outside");
  await mkdir(workspaceRoot);
  await mkdir(outsideRoot);
  const env = new Drive9ExecutionEnv({ workspaceRoot, ...options });
  environments.push(env);
  return { env, workspaceRoot, outsideRoot };
}

function assertErrorCode(
  result: { ok: true; value: unknown } | { ok: false; error: { code: string } },
  code: string,
): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, code);
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

afterEach(async () => {
  for (const env of environments.splice(0)) await env.cleanup();
  for (const root of testRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Drive9ExecutionEnv", () => {
  it("implements normal file operations inside the workspace", async () => {
    const { env, workspaceRoot } = await createEnvironment();

    assert.equal(getOrThrow(await env.absolutePath("nested/file.txt")), join(workspaceRoot, "nested/file.txt"));
    assert.equal(getOrThrow(await env.joinPath(["nested", "file.txt"])), join(workspaceRoot, "nested/file.txt"));
    getOrThrow(await env.writeFile("nested/file.txt", "hello"));
    getOrThrow(await env.appendFile("nested/file.txt", " world"));
    assert.equal(getOrThrow(await env.readTextFile("nested/file.txt")), "hello world");
    assert.deepEqual(getOrThrow(await env.readTextLines("nested/file.txt", { maxLines: 1 })), ["hello world"]);
    assert.equal(Buffer.from(getOrThrow(await env.readBinaryFile("nested/file.txt"))).toString("utf8"), "hello world");
    assert.equal(getOrThrow(await env.exists("nested/file.txt")), true);
    assert.equal(getOrThrow(await env.exists(".")), true);
    assert.equal(getOrThrow(await env.fileInfo(".")).kind, "directory");
    assert.deepEqual(
      getOrThrow(await env.listDir("nested")).map(({ name, kind }) => ({ name, kind })),
      [{ name: "file.txt", kind: "file" }],
    );
    getOrThrow(await env.renameFile("nested/file.txt", "nested/renamed.txt"));
    assert.equal(getOrThrow(await env.exists("nested/file.txt")), false);
    assert.equal(getOrThrow(await env.readTextFile("nested/renamed.txt")), "hello world");
    getOrThrow(await env.remove("nested", { recursive: true }));
    assert.equal(getOrThrow(await env.exists("nested")), false);
  });

  it("requires absolute, existing, root-contained construction paths", async () => {
    const container = await createTestRoot("drive9-pi-options-");
    const workspaceRoot = join(container, "workspace");
    const outsideRoot = join(container, "outside");
    await mkdir(workspaceRoot);
    await mkdir(outsideRoot);

    assert.throws(() => new Drive9ExecutionEnv({ workspaceRoot: "relative" }), /absolute path/);
    assert.throws(() => new Drive9ExecutionEnv({ workspaceRoot: join(container, "missing") }), /ENOENT/);
    assert.throws(() => new Drive9ExecutionEnv({ workspaceRoot, cwd: outsideRoot }), /inside workspaceRoot/);
    assert.throws(() => new Drive9ExecutionEnv({ workspaceRoot, tempRoot: outsideRoot }), /inside workspaceRoot/);

    const escapedCwd = join(workspaceRoot, "escaped-cwd");
    const escapedTempRoot = join(workspaceRoot, "escaped-temp");
    await symlink(outsideRoot, escapedCwd);
    await symlink(outsideRoot, escapedTempRoot);
    assert.throws(() => new Drive9ExecutionEnv({ workspaceRoot, cwd: escapedCwd }), /escapes workspaceRoot/);
    assert.throws(() => new Drive9ExecutionEnv({ workspaceRoot, tempRoot: escapedTempRoot }), /escapes workspaceRoot/);
  });

  it("rejects lexical escape for path and mutation operations", async () => {
    const { env, workspaceRoot, outsideRoot } = await createEnvironment();
    const escapedRelative = join("..", "outside", "escaped.txt");
    const outsideFile = join(outsideRoot, "escaped.txt");

    for (const result of [
      await env.absolutePath(escapedRelative),
      await env.absolutePath(outsideFile),
      await env.joinPath([workspaceRoot, "..", "outside"]),
      await env.writeFile(escapedRelative, "blocked"),
      await env.appendFile(outsideFile, "blocked"),
      await env.createDir(escapedRelative),
      await env.remove(outsideFile, { force: true }),
    ]) {
      assertErrorCode(result, "permission_denied");
    }
    await assert.rejects(readFile(outsideFile));
  });

  it("rejects followed symlink escape but can inspect and remove the link itself", async () => {
    const { env, workspaceRoot, outsideRoot } = await createEnvironment();
    const outsideFile = join(outsideRoot, "outside.txt");
    const outsideDirectory = join(outsideRoot, "dir");
    await writeFile(outsideFile, "outside");
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, "child.txt"), "outside child");
    await symlink(outsideFile, join(workspaceRoot, "file-link"));
    await symlink(outsideDirectory, join(workspaceRoot, "dir-link"));

    assertErrorCode(await env.readTextFile("file-link"), "permission_denied");
    assertErrorCode(await env.readBinaryFile("file-link"), "permission_denied");
    assertErrorCode(await env.canonicalPath("file-link"), "permission_denied");
    assertErrorCode(await env.listDir("dir-link"), "permission_denied");
    assertErrorCode(await env.fileInfo("dir-link/child.txt"), "permission_denied");
    assertErrorCode(await env.writeFile("file-link", "blocked"), "permission_denied");
    assertErrorCode(await env.writeFile("dir-link/new.txt", "blocked"), "permission_denied");

    assert.equal(getOrThrow(await env.fileInfo("file-link")).kind, "symlink");
    getOrThrow(await env.remove("file-link"));
    assert.equal(await readFile(outsideFile, "utf8"), "outside");
    assert.equal(getOrThrow(await env.exists("file-link")), false);
  });

  it("allows root-contained symlink aliases without bypassing serialized mutations", async () => {
    const { env, workspaceRoot } = await createEnvironment();
    await mkdir(join(workspaceRoot, "real"));
    await symlink(join(workspaceRoot, "real"), join(workspaceRoot, "alias"));

    const write = env.writeFile("real/file.txt", "first");
    const append = env.appendFile("alias/file.txt", " second");
    assert.equal(getOrThrow(await write), undefined);
    assert.equal(getOrThrow(await append), undefined);
    assert.equal(getOrThrow(await env.readTextFile("real/file.txt")), "first second");
  });

  it("guards both rename parents and refuses workspace-root mutations", async () => {
    const { env, workspaceRoot, outsideRoot } = await createEnvironment();
    await writeFile(join(workspaceRoot, "source.txt"), "source");
    await mkdir(join(outsideRoot, "directory"));
    await symlink(join(outsideRoot, "directory"), join(workspaceRoot, "outside-link"));

    assertErrorCode(await env.renameFile("source.txt", "outside-link/destination.txt"), "permission_denied");
    assert.equal(await readFile(join(workspaceRoot, "source.txt"), "utf8"), "source");
    assertErrorCode(await env.renameFile(workspaceRoot, join(workspaceRoot, "renamed-root")), "permission_denied");
    assertErrorCode(await env.remove(workspaceRoot, { recursive: true }), "permission_denied");
  });

  it("creates private temporary paths inside tempRoot and removes only owned paths", async () => {
    const { env } = await createEnvironment();
    const sibling = join(env.tempRoot, "keep.txt");
    await writeFile(sibling, "keep");

    const temporaryDirectory = getOrThrow(await env.createTempDir("dir-"));
    const emptyPrefixDirectory = getOrThrow(await env.createTempDir(""));
    const temporaryFile = getOrThrow(await env.createTempFile({ prefix: "file-", suffix: ".txt" }));
    const canonicalTempRoot = await realpath(env.tempRoot);
    assert.equal((await stat(dirname(temporaryDirectory))).mode & 0o777, 0o700);
    assert.equal(isInside(canonicalTempRoot, await realpath(temporaryDirectory)), true);
    assert.equal(isInside(canonicalTempRoot, await realpath(emptyPrefixDirectory)), true);
    assert.equal(isInside(canonicalTempRoot, await realpath(temporaryFile)), true);
    assertErrorCode(await env.createTempDir("../escape"), "invalid");
    assertErrorCode(await env.createTempDir("."), "invalid");
    assertErrorCode(await env.createTempDir(".."), "invalid");
    assertErrorCode(await env.createTempDir(null as unknown as string), "invalid");
    assertErrorCode(await env.createTempFile({ prefix: "nested/path" }), "invalid");

    await env.cleanup();
    assert.equal(await readFile(sibling, "utf8"), "keep");
    await assert.rejects(readFile(temporaryFile));
  });

  it("maps pre-aborted filesystem operations to FileError without rejecting", async () => {
    const { env } = await createEnvironment();
    getOrThrow(await env.writeFile("file.txt", "content"));
    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;

    const results = await Promise.all([
      env.absolutePath("file.txt", signal),
      env.joinPath(["file.txt"], signal),
      env.readTextFile("file.txt", signal),
      env.readTextLines("file.txt", { abortSignal: signal }),
      env.readBinaryFile("file.txt", signal),
      env.writeFile("other.txt", "x", signal),
      env.appendFile("other.txt", "x", signal),
      env.renameFile("file.txt", "renamed.txt", signal),
      env.fileInfo("file.txt", signal),
      env.listDir(".", signal),
      env.canonicalPath("file.txt", signal),
      env.exists("file.txt", signal),
      env.createDir("directory", { abortSignal: signal }),
      env.remove("file.txt", { abortSignal: signal }),
      env.createTempDir("dir-", signal),
      env.createTempFile({ abortSignal: signal }),
    ]);

    for (const result of results) assertErrorCode(result, "aborted");
  });

  it("returns invalid filesystem errors instead of rejecting unexpected paths", async () => {
    const { env } = await createEnvironment();
    const result = await env.readTextFile("x".repeat(5000));
    assertErrorCode(result, "invalid");
  });

  it("maps unexpected backend throws to unknown filesystem results", async () => {
    const { env } = await createEnvironment();
    getOrThrow(await env.writeFile("existing.txt", "content"));
    const backend = (env as unknown as { nodeEnv: Record<string, unknown> }).nodeEnv;

    backend.readTextFile = async () => {
      throw new Error("unexpected read backend failure");
    };
    assertErrorCode(await env.readTextFile("existing.txt"), "unknown");

    backend.writeFile = async () => {
      throw new Error("unexpected write backend failure");
    };
    assertErrorCode(await env.writeFile("other.txt", "content"), "unknown");
  });

  it("executes only from a root-contained cwd and supplies private temp variables", async () => {
    const { env, workspaceRoot, outsideRoot } = await createEnvironment({ env: { DRIVE9_PI_DEFAULT: "configured" } });
    const insideDirectory = join(workspaceRoot, "inside");
    await mkdir(insideDirectory);
    await symlink(outsideRoot, join(workspaceRoot, "outside-link"));

    const command = `printf '%s|%s|%s|%s|%s' "$PWD" "$TMPDIR" "$TMP" "$TEMP" "$DRIVE9_PI_DEFAULT"`;
    const execution = getOrThrow(await env.exec(command, { cwd: insideDirectory }));
    assert.equal(execution.exitCode, 0);
    const [cwd, tmpdirValue, tmpValue, tempValue, configured] = execution.stdout.split("|");
    assert.equal(cwd, await realpath(insideDirectory));
    assert.equal(tmpdirValue, tmpValue);
    assert.equal(tmpValue, tempValue);
    assert.equal(isInside(await realpath(env.tempRoot), tmpdirValue ?? ""), true);
    assert.equal(configured, "configured");

    assertErrorCode(await env.exec("printf blocked", { cwd: outsideRoot }), "spawn_error");
    assertErrorCode(await env.exec("printf blocked", { cwd: "outside-link" }), "spawn_error");
  });

  it("keeps temp defaults with inheritEnv false and permits explicit overrides", async () => {
    const { env, workspaceRoot } = await createEnvironment({ env: { DRIVE9_PI_DEFAULT: "configured" } });
    const inherited = getOrThrow(
      await env.exec(`printf '%s|%s' "$TMPDIR" "${"${DRIVE9_PI_DEFAULT-unset}"}"`, { inheritEnv: false }),
    );
    const [privateTemp, configured] = inherited.stdout.split("|");
    assert.equal(isInside(await realpath(env.tempRoot), privateTemp ?? ""), true);
    assert.equal(configured, "unset");

    const explicit = getOrThrow(
      await env.exec(`printf '%s' "$TMPDIR"`, { env: { TMPDIR: join(workspaceRoot, "explicit-temp") } }),
    );
    assert.equal(explicit.stdout, join(workspaceRoot, "explicit-temp"));
  });

  it("maps shell callback, abort, and invalid-cwd failures without rejecting", async () => {
    const { env } = await createEnvironment();
    const callback = await env.exec("printf output", {
      onStdout: () => {
        throw new Error("callback failed");
      },
    });
    assertErrorCode(callback, "callback_error");

    const controller = new AbortController();
    controller.abort();
    assertErrorCode(await env.exec("sleep 5", { abortSignal: controller.signal }), "aborted");
    assertErrorCode(await env.exec("printf output", { cwd: "missing" }), "spawn_error");
  });

  it("preserves shell timeouts and cleanup terminates active commands", async () => {
    const { env } = await createEnvironment();
    assertErrorCode(await env.exec("sleep 1", { timeout: 0.02 }), "timeout");

    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    const execution = env.exec("printf started; sleep 30", {
      onStdout: (chunk) => {
        if (chunk.includes("started")) markStarted?.();
      },
    });
    await started;
    await env.cleanup();
    await Promise.race([
      execution,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("active command survived cleanup")), 2000);
      }),
    ]);
  });
});
