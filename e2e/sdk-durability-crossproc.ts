/**
 * REAL-backend, cross-process acknowledgement-durability E2E.
 *
 * The parent writes and appends through Drive9DurableFileSystem. Immediately
 * after each acknowledged mutation, a fresh Node process creates its own
 * Client.defaultClient() and performs exactly one read. There is no sleep or
 * visibility retry between acknowledgement and verification, so a client or
 * server that acknowledges before the bytes are remotely readable fails.
 *
 * flushFile is then exercised as the documented confirmation barrier: Drive9
 * has no buffered file handle to flush, so another fresh process must still
 * read the exact acknowledged bytes after flush returns.
 *
 * This closes only the direct-SDK acknowledgement-visibility gate for the
 * tested Drive9 deployment. It does not prove server-enforced Pi state-writer
 * fencing, nonzero truncate, mounted quiesce, or LayerFS publication.
 *
 * Teardown removes the unique remote root in a finally path and verifies that
 * it no longer exists. If the backend is unavailable the script prints SKIP by
 * default; set DRIVE9_E2E_REQUIRED=1 to fail instead.
 *
 * Run:
 *   DRIVE9_E2E_REQUIRED=1 node --import tsx e2e/sdk-durability-crossproc.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Client } from "drive9";
import { Drive9DurableFileSystem } from "../src/drive9-durable-file-system.js";

const FILE_NAME = "acknowledged.bin";
const WRITE_BYTES = Uint8Array.from([
  0x00, 0x44, 0x72, 0x69, 0x76, 0x65, 0x39, 0x2d, 0x77, 0x72, 0x69, 0x74, 0x65, 0xff,
]);
const APPEND_BYTES = Uint8Array.from([0x0a, 0x61, 0x70, 0x70, 0x65, 0x6e, 0x64, 0x00, 0xfe]);

type ChildPayload = {
  readonly label: string;
  readonly root: string;
  readonly expectedHex: string;
};

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

async function withRetry<T>(label: string, attempts: number, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${String(lastError)}`);
}

function createFileSystem(client: Client, root: string): Drive9DurableFileSystem {
  return new Drive9DurableFileSystem({
    client,
    root,
    cwd: root,
    tempRoot: `${root}/.tmp`,
    id: `drive9-sdk-e2e:${root}`,
  });
}

async function backendAvailable(client: Client): Promise<boolean> {
  try {
    await withRetry("backend probe", 3, async () => {
      await client.warm();
      await client.stat("/");
    });
    return true;
  } catch (error) {
    if (process.env.DRIVE9_E2E_REQUIRED === "1") throw error;
    process.stdout.write(`SKIP: Drive9 backend unavailable: ${String(error)}\n`);
    return false;
  }
}

async function runChild(): Promise<void> {
  const payload = JSON.parse(process.env.DRIVE9_E2E_PAYLOAD ?? "{}") as ChildPayload;
  assert.ok(payload.root.startsWith("/drive9-pi-sdk-ack-e2e-"), "child root must be the E2E namespace");
  const client = Client.defaultClient();
  const fileSystem = createFileSystem(client, payload.root);

  // Deliberately one read with no retry or sleep: acknowledgement visibility
  // must not depend on eventual propagation.
  const actual = getOrThrow(await fileSystem.readBinaryFile(FILE_NAME, BACKGROUND_CONTEXT));
  const expected = Buffer.from(payload.expectedHex, "hex");
  assert.ok(expected.equals(Buffer.from(actual)), `${payload.label} bytes must be remotely readable after ack`);
  process.stdout.write(`CHILD-OK: ${payload.label} exact bytes are visible from an independent process\n`);
}

function verifyFromFreshProcess(payload: ChildPayload): void {
  const self = fileURLToPath(import.meta.url);
  const result = spawnSync(process.execPath, ["--import", "tsx", self], {
    env: {
      ...process.env,
      DRIVE9_E2E_ROLE: "child",
      DRIVE9_E2E_PAYLOAD: JSON.stringify(payload),
    },
    stdio: "inherit",
    timeout: 30_000,
  });
  if (result.error !== undefined) throw result.error;
  assert.equal(result.signal, null, `${payload.label} child must not be killed`);
  assert.equal(result.status, 0, `${payload.label} child must verify exact bytes`);
}

async function cleanup(client: Client, root: string): Promise<void> {
  try {
    await withRetry("remove E2E root", 3, () => client.removeAll(root));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await client.stat(root);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(`cleanup left E2E root active: ${root}`);
}

async function runParent(): Promise<void> {
  const client = Client.defaultClient();
  if (!(await backendAvailable(client))) return;

  const root = `/drive9-pi-sdk-ack-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
  let runError: unknown;
  let cleanupError: unknown;
  try {
    await client.mkdir(root, 0o700);
    const fileSystem = createFileSystem(client, root);

    getOrThrow(await fileSystem.writeFile(FILE_NAME, WRITE_BYTES, BACKGROUND_CONTEXT));
    verifyFromFreshProcess({
      label: "write acknowledgement",
      root,
      expectedHex: Buffer.from(WRITE_BYTES).toString("hex"),
    });

    getOrThrow(await fileSystem.appendFile(FILE_NAME, APPEND_BYTES, BACKGROUND_CONTEXT));
    const appended = Buffer.concat([Buffer.from(WRITE_BYTES), Buffer.from(APPEND_BYTES)]);
    verifyFromFreshProcess({
      label: "append acknowledgement",
      root,
      expectedHex: appended.toString("hex"),
    });

    getOrThrow(await fileSystem.flushFile(FILE_NAME, BACKGROUND_CONTEXT));
    verifyFromFreshProcess({
      label: "flush confirmation",
      root,
      expectedHex: appended.toString("hex"),
    });
  } catch (error) {
    runError = error;
  } finally {
    try {
      await cleanup(client, root);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (runError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([runError, cleanupError], "SDK durability E2E and cleanup both failed");
  }
  if (runError !== undefined) throw runError;
  if (cleanupError !== undefined) throw cleanupError;
  process.stdout.write("PASS: direct SDK write/append/flush acknowledgements are cross-process readable\n");
}

async function main(): Promise<void> {
  if (process.env.DRIVE9_E2E_ROLE === "child") await runChild();
  else await runParent();
}

await main();
