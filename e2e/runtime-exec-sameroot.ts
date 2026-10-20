/**
 * Real-backend acceptance for Drive9 Runtime exec (task #282, V1 ordinary root).
 *
 * Proves the "same workspace" promise end-to-end against a real Drive9 server
 * with Runtime enabled:
 *   1. The agent writes a file through `Drive9SdkExecutionEnv` (the filesystem).
 *   2. A command run via `env.exec` (Runtime, ordinary root, no layer_id) SEES
 *      that file at the same relative path.
 *   3. The command writes another file; the filesystem SEES the command's write.
 * This is the discriminating bidirectional-visibility check: a broken binding
 * (different root/sandbox, or a host shell) cannot satisfy both directions.
 *
 * Uses `Client.defaultClient()` (~/.drive9/config). If the backend is
 * unreachable OR Runtime is not enabled, prints SKIP and exits 0 by default;
 * set DRIVE9_E2E_REQUIRED=1 to make that a failure. No host-shell fallback, no
 * mock: fail closed.
 *
 * Gate: DRIVE9_E2E_REQUIRED=1 npm run e2e:runtime-exec
 */
import { Client, RuntimeNotEnabledError } from "drive9";
import { Drive9SdkExecutionEnv } from "../src/index.js";

const REQUIRED = process.env.DRIVE9_E2E_REQUIRED === "1";

function fail(message: string): never {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function skip(message: string): never {
  if (REQUIRED) fail(`${message} (DRIVE9_E2E_REQUIRED=1)`);
  process.stdout.write(`SKIP: ${message}\n`);
  process.exit(0);
}

const context = { abortSignal: new AbortController().signal } as unknown as import("@earendil-works/chord").Context;

async function main(): Promise<void> {
  let client: Client;
  try {
    client = Client.defaultClient();
  } catch (error) {
    skip(`no Drive9 client configured: ${(error as Error).message}`);
  }

  const root = `/dev1-runtime-exec-${process.pid}`;
  // Minimal filesystem client adapter over the SDK (mirrors the demo's shape).
  const fsClient = makeFsClient(client, root);
  const env = new Drive9SdkExecutionEnv({ client: fsClient, root, runtime: client });

  try {
    // 1. Agent writes a file via the filesystem.
    const wrote = await env.writeFile("from-agent.txt", new TextEncoder().encode("hello-from-agent\n"), context);
    if (!wrote.ok) fail(`filesystem write failed: ${wrote.error.message}`);

    // 2. Command sees the agent's file, and writes one back.
    let output = "";
    const exec = await env.exec("cat from-agent.txt && echo cmd-was-here > from-cmd.txt", {
      onOutput: (text) => {
        output += text;
      },
    }, context);
    if (!exec.ok) {
      if (exec.error.cause instanceof RuntimeNotEnabledError || exec.error.code === "shell_unavailable") {
        skip("Runtime exec not enabled on this server");
      }
      fail(`exec failed: ${exec.error.code} ${exec.error.message}`);
    }
    if (exec.value.exitCode !== 0) fail(`exec exit ${exec.value.exitCode}`);
    if (!output.includes("hello-from-agent")) fail(`command did not see the agent's file; output=${JSON.stringify(output)}`);

    // 3. Filesystem sees the command's write (same root).
    const back = await env.readTextFile("from-cmd.txt", context);
    if (!back.ok) fail(`filesystem could not read the command's file: ${back.error.message}`);
    if (!back.value.includes("cmd-was-here")) fail(`unexpected content from command: ${JSON.stringify(back.value)}`);

    process.stdout.write("PASS: bidirectional same-root visibility (fs→exec and exec→fs)\n");
  } finally {
    await env.cleanup(context).catch(() => {});
  }
}

/** The SDK Client exposes file ops; adapt the subset Drive9DurableFileSystem needs, rooted at `root`. */
function makeFsClient(client: Client, root: string): import("../src/drive9-durable-file-system.js").Drive9DurableFileSystemClient {
  const abs = (p: string) => (p.startsWith("/") ? p : `${root}/${p}`);
  return {
    read: (p) => client.read(abs(p)),
    write: async (p, data) => {
      await client.write(abs(p), data);
    },
    append: async (p, data) => {
      await client.append(abs(p), data);
    },
    list: async (p) => (await client.list(abs(p))).map((e) => ({ name: e.name, size: e.size, isDir: e.isDir })),
    stat: async (p) => {
      const s = await client.stat(abs(p));
      return { size: s.size, isDir: s.isDir, revision: s.revision };
    },
    rename: async (from, to) => {
      await client.rename(abs(from), abs(to));
    },
    mkdir: async (p) => {
      await client.mkdir(abs(p));
    },
    deleteFile: async (p) => {
      await client.delete(abs(p));
    },
    deleteDir: async (p) => {
      await client.delete(abs(p));
    },
    removeAll: async (p) => {
      await client.delete(abs(p));
    },
  };
}

void main().catch((error) => fail((error as Error).message));
