/**
 * Real-backend acceptance for Drive9 Runtime exec (task #282, V1 ordinary root).
 *
 * One SDK Client object backs both halves of `Drive9SdkExecutionEnv`. The gate
 * proves bidirectional visibility under the configured start root without a
 * host fallback. It does not claim that Runtime access is confined to root:
 *
 *   filesystem write -> Runtime read
 *   Runtime write -> filesystem read
 *
 * Cleanup always removes and verifies the unique remote root, including SKIP
 * and assertion-failure paths. Set DRIVE9_E2E_REQUIRED=1 to turn an unavailable
 * backend or Runtime capability into a hard failure.
 */
import { randomUUID } from "node:crypto";
import { Client, RuntimeNotEnabledError } from "drive9";
import { Drive9SdkExecutionEnv } from "../src/index.js";
import { withVerifiedCleanup } from "./verified-cleanup.js";

const REQUIRED = process.env.DRIVE9_E2E_REQUIRED === "1";
const context = {
  abortSignal: new AbortController().signal,
} as unknown as import("@earendil-works/chord").Context;

class SkipError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkipError";
  }
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { readonly statusCode?: unknown }).statusCode;
  if (typeof value === "number") return value;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function isMissing(error: unknown): boolean {
  return statusCode(error) === 404 || String(error).toLowerCase().includes("not found");
}

async function cleanupRoot(client: Client, root: string): Promise<void> {
  try {
    await client.removeAll(root);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await client.stat(root);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(`cleanup left Runtime E2E root active: ${root}`);
}

async function configuredClient(): Promise<Client> {
  let client: Client;
  try {
    client = Client.defaultClient();
  } catch (error) {
    throw new SkipError(`no Drive9 client configured: ${String(error)}`, { cause: error });
  }
  try {
    await client.runtimeCapabilities(context.abortSignal);
  } catch (error) {
    if (error instanceof RuntimeNotEnabledError) {
      throw new SkipError("Runtime exec is not enabled on this server", { cause: error });
    }
    throw new SkipError(`Drive9 Runtime backend unavailable: ${String(error)}`, { cause: error });
  }
  return client;
}

async function run(): Promise<void> {
  const client = await configuredClient();
  const root = `/drive9-pi-runtime-exec-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const environment = new Drive9SdkExecutionEnv({
    client,
    root,
    tempRoot: `${root}/.tmp`,
    id: `drive9-runtime-e2e:${root}`,
  });
  await withVerifiedCleanup(
    async () => {
      await client.mkdir(root, 0o700);
      const wrote = await environment.writeFile(
        "from-agent.txt",
        new TextEncoder().encode("hello-from-agent\n"),
        context,
      );
      if (!wrote.ok) throw wrote.error;

      let output = "";
      const executed = await environment.exec(
        "cat from-agent.txt && printf 'cmd-was-here\\n' > from-cmd.txt",
        { onOutput: (text) => { output += text; } },
        context,
      );
      if (!executed.ok) {
        if (executed.error.cause instanceof RuntimeNotEnabledError || executed.error.code === "shell_unavailable") {
          throw new SkipError("Runtime exec became unavailable after capability preflight", { cause: executed.error });
        }
        throw executed.error;
      }
      if (executed.value.exitCode !== 0) {
        throw new Error(`Runtime command exited ${executed.value.exitCode}`);
      }
      if (output !== "hello-from-agent\n") {
        throw new Error(`Runtime did not see the filesystem write: ${JSON.stringify(output)}`);
      }

      const readBack = await environment.readTextFile("from-cmd.txt", context);
      if (!readBack.ok) throw readBack.error;
      if (readBack.value !== "cmd-was-here\n") {
        throw new Error(`filesystem did not see the Runtime write: ${JSON.stringify(readBack.value)}`);
      }
    },
    async () => {
      await environment.cleanup(context);
      await cleanupRoot(client, root);
    },
  );
  process.stdout.write("PASS: one Drive9 client has bidirectional filesystem/Runtime visibility and cleanup is verified\n");
}

try {
  await run();
} catch (error) {
  if (error instanceof SkipError && !REQUIRED) {
    process.stdout.write(`SKIP: ${error.message}\n`);
  } else {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
