import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Agent, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Client } from "drive9";
import { Drive9ExecutionEnv } from "../src/drive9-execution-env.js";
import { createDrive9ResultStore } from "../src/drive9-result-backend.js";
import { verifyEvidenceIsolation } from "../src/evidence-isolation.js";
import {
  createAfterToolCallFallback,
  createDrive9ExecTool,
  createResultReadTool,
  createResultSearchTool,
  type CompactToolResultDetails,
  type ToolResultIdentityAllocator,
} from "../src/pi-adapters.js";
import {
  createPrivateCommandEnvironment,
  createTrustedHelperEnvironment,
} from "../src/private-command-environment.js";
import { deriveResultId } from "../src/result-id.js";
import type { ToolResultIdentity } from "../src/tool-result-types.js";
import {
  createDrive9MountDrain,
  Drive9LayerWorkspaceRevisionProvider,
} from "../src/workspace-revision.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function readCredential(name: string): Promise<string> {
  const fileName = `${name}_FILE`;
  const direct = process.env[name];
  const path = process.env[fileName];
  delete process.env[name];
  delete process.env[fileName];
  if (direct !== undefined && direct.trim().length > 0) return direct.trim();
  if (path !== undefined && path.trim().length > 0) return (await readFile(path.trim(), "utf8")).trim();
  throw new Error(`${name} or ${fileName} is required`);
}

function textBytes(message: ToolResultMessage): number {
  return message.content.reduce(
    (total, part) => total + (part.type === "text" ? Buffer.byteLength(part.text, "utf8") : 0),
    0,
  );
}

function usage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "drive9-pi-demo",
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function lastToolResult(context: Context, toolName: string): ToolResultMessage {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role === "toolResult" && message.toolName === toolName) return message;
  }
  throw new Error(`missing ${toolName} tool result`);
}

function scriptedStream(): StreamFn {
  let turn = 0;
  return async (_model, context) => {
    turn += 1;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      let message: AssistantMessage;
      if (turn === 1) {
        message = assistant(
          [
            {
              type: "toolCall",
              id: "demo-exec",
              name: "drive9_exec",
              arguments: { command: requiredEnvironment("DRIVE9_PI_DEMO_COMMAND"), timeoutSeconds: 120 },
            },
          ],
          "toolUse",
        );
      } else if (turn === 2) {
        const details = lastToolResult(context, "drive9_exec").details as CompactToolResultDetails;
        message = assistant(
          [
            {
              type: "toolCall",
              id: "demo-search",
              name: "result_search",
              arguments: {
                resultId: details.resultId,
                query: "drive9-pi-known-late-failure",
                contextBytes: 256,
              },
            },
          ],
          "toolUse",
        );
      } else if (turn === 3) {
        const details = lastToolResult(context, "result_search").details as {
          resultId: string;
          matches: Array<{ line: number }>;
        };
        const line = details.matches[0]?.line;
        if (line === undefined) throw new Error("known late failure was not found");
        message = assistant(
          [
            {
              type: "toolCall",
              id: "demo-read",
              name: "result_read",
              arguments: {
                resultId: details.resultId,
                startLine: Math.max(0, line - 3),
                maxLines: 8,
                maxBytes: 4096,
              },
            },
          ],
          "toolUse",
        );
      } else {
        message = assistant([{ type: "text", text: "Drive9 Pi evidence demo complete." }], "stop");
      }
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    });
    return stream;
  };
}

interface EvidenceObjectProof {
  revision: number;
  sha256: string;
  bytes: number;
}

interface EvidenceProof {
  manifest: EvidenceObjectProof;
  chunks: EvidenceObjectProof[];
}

async function evidenceProof(
  client: Client,
  evidenceRoot: string,
  resultId: string,
  chunkCount: number,
): Promise<EvidenceProof> {
  const digest = resultId.slice(3);
  const directory = posix.join(
    evidenceRoot,
    "v1/results",
    digest.slice(0, 2),
    digest.slice(2, 4),
    resultId,
  );
  const inspect = async (path: string): Promise<EvidenceObjectProof> => {
    const stat = await client.stat(path);
    const data = await client.read(path);
    if (stat.revision <= 0 || stat.size !== data.byteLength) throw new Error("evidence object metadata mismatch");
    return {
      revision: stat.revision,
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.byteLength,
    };
  };
  const chunks: EvidenceObjectProof[] = [];
  for (let sequence = 0; sequence < chunkCount; sequence += 1) {
    chunks.push(await inspect(posix.join(directory, "chunks", `${sequence.toString().padStart(12, "0")}.json`)));
  }
  return { manifest: await inspect(posix.join(directory, "manifest.json")), chunks };
}

async function waitForWorkspaceRollback(env: Drive9ExecutionEnv, fixturePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const exists = await env.exists(fixturePath);
    if (!exists.ok) throw exists.error;
    if (!exists.value) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("workspace fixture remained visible after layer rollback");
}

async function crashWriter(): Promise<never> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    baseUrl: string;
    evidenceRoot: string;
    evidenceKey: string;
    identity: ToolResultIdentity;
  };
  const { baseUrl, evidenceRoot, evidenceKey, identity } = input;
  const client = new Client(baseUrl, evidenceKey);
  const store = createDrive9ResultStore({ client, evidenceRoot });
  const begun = await store.begin({
    identity,
    toolName: "drive9_exec",
    mediaType: "text/plain; charset=utf-8",
  });
  if (begun.kind !== "writing") throw new Error("crash fixture unexpectedly terminal");
  await begun.writer.append({ seq: 0, stream: "tool", data: Buffer.from("durable-before-sigkill\n") });
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not terminate the crash writer");
}

async function runCrashRecovery(
  baseUrl: string,
  evidenceRoot: string,
  evidenceKey: string,
  store: ReturnType<typeof createDrive9ResultStore>,
  env: Drive9ExecutionEnv,
  commandEnvironment: Record<string, string>,
): Promise<{
  abandonedResultId: string;
  abandonedState: string;
  abandonedChunkCount: number;
  restartedResultId: string;
  restartedState: string;
}> {
  const identity: ToolResultIdentity = {
    sessionId: `crash-session-${randomUUID()}`,
    runId: "crash-run",
    toolCallId: "crash-tool",
    attempt: 0,
  };
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
      cwd: repositoryRoot,
      env: createTrustedHelperEnvironment({
        DRIVE9_PI_DEMO_PHASE: "crash-writer",
        HOME: commandEnvironment.HOME ?? "",
        XDG_CONFIG_HOME: commandEnvironment.XDG_CONFIG_HOME ?? "",
        XDG_CACHE_HOME: commandEnvironment.XDG_CACHE_HOME ?? "",
        XDG_DATA_HOME: commandEnvironment.XDG_DATA_HOME ?? "",
        XDG_STATE_HOME: commandEnvironment.XDG_STATE_HOME ?? "",
      }),
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (Buffer.byteLength(stderr) < 4096) stderr += chunk.toString();
    });
    child.once("error", rejectPromise);
    child.once("close", (_code, signal) => {
      if (signal === "SIGKILL") resolvePromise();
      else rejectPromise(new Error(`crash writer did not terminate with SIGKILL: ${stderr.trim()}`));
    });
    child.stdin?.end(JSON.stringify({ baseUrl, evidenceRoot, evidenceKey, identity }));
  });
  const abandonedResultId = deriveResultId(identity);
  const restart = createDrive9ExecTool({
    env,
    store,
    allocateIdentity: ({ previous }) =>
      previous === undefined ? identity : { ...identity, attempt: previous.attempt + 1 },
    commandEnvironment,
  });
  const restarted = await restart.execute(identity.toolCallId, { command: "printf restarted-after-sigkill" });
  const abandoned = await store.stat(abandonedResultId);
  if (abandoned.state !== "unknown" || abandoned.chunkCount < 1) {
    throw new Error("crash recovery produced a false terminal state");
  }
  if (
    restarted.details.state !== "completed" ||
    restarted.details.resultId === abandonedResultId ||
    restarted.details.resultId !== deriveResultId({ ...identity, attempt: 1 })
  ) {
    throw new Error("crash recovery did not execute a fresh attempt");
  }
  return {
    abandonedResultId,
    abandonedState: abandoned.state,
    abandonedChunkCount: abandoned.chunkCount,
    restartedResultId: restarted.details.resultId,
    restartedState: restarted.details.state,
  };
}

async function main(): Promise<void> {
  if (process.env.DRIVE9_PI_DEMO_PHASE === "crash-writer") await crashWriter();

  const baseUrl = requiredEnvironment("DRIVE9_PI_BASE_URL");
  const mountPoint = requiredEnvironment("DRIVE9_PI_MOUNT");
  const workspaceRemoteRoot = requiredEnvironment("DRIVE9_PI_WORKSPACE_REMOTE_ROOT");
  const mountRemoteRoot = requiredEnvironment("DRIVE9_PI_MOUNT_REMOTE_ROOT");
  const evidenceRoot = requiredEnvironment("DRIVE9_PI_EVIDENCE_REMOTE_ROOT");
  const layerId = requiredEnvironment("DRIVE9_PI_LAYER_ID");
  const drive9Path = process.env.DRIVE9_BIN?.trim() || "/usr/local/bin/drive9";
  const workspaceKey = await readCredential("DRIVE9_PI_WORKSPACE_API_KEY");
  const evidenceKey = await readCredential("DRIVE9_PI_EVIDENCE_API_KEY");
  const workspaceClient = new Client(baseUrl, workspaceKey);
  const evidenceClient = new Client(baseUrl, evidenceKey);

  await verifyEvidenceIsolation({
    workspaceRemoteRoot,
    workspaceMountRemoteRoot: mountRemoteRoot,
    evidenceRemoteRoot: evidenceRoot,
    workspaceClient,
    evidenceClient,
  });

  const drain = createDrive9MountDrain({ mountPoint, drive9Path, timeoutSeconds: 30 });
  const revisions = new Drive9LayerWorkspaceRevisionProvider({
    client: workspaceClient,
    layerId,
    drain,
    checkpointLabel: "drive9-pi-e2e",
    checkpointId: () => `pi-${randomUUID()}`,
  });
  const env = new Drive9ExecutionEnv({ workspaceRoot: mountPoint });
  const store = createDrive9ResultStore({ client: evidenceClient, evidenceRoot });
  const sessionId = `pi-demo-session-${randomUUID()}`;
  const runId = `pi-demo-run-${randomUUID()}`;
  const attempts = new Map<string, number>();
  const allocateIdentity: ToolResultIdentityAllocator = ({ toolCallId, previous }) => {
    const attempt = previous === undefined ? (attempts.get(toolCallId) ?? 0) : previous.attempt + 1;
    attempts.set(toolCallId, attempt);
    return { sessionId, runId, toolCallId, attempt };
  };

  const fixtureDirectory = `.drive9-pi-demo-${randomUUID()}`;
  const privateHome = posix.join(mountPoint, `.drive9-pi-home-${randomUUID()}`);
  const fixtureFile = posix.join(fixtureDirectory, "fixture.test.mjs");
  const fixturePackage = posix.join(fixtureDirectory, "package.json");
  const directoryResult = await env.createDir(fixtureDirectory);
  if (!directoryResult.ok) throw directoryResult.error;
  const homeResult = await env.createDir(privateHome);
  if (!homeResult.ok) throw homeResult.error;
  const commandEnvironment = createPrivateCommandEnvironment({
    home: privateHome,
    path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  });
  const packageResult = await env.writeFile(
    fixturePackage,
    JSON.stringify({ private: true, scripts: { test: "node --test fixture.test.mjs" } }),
  );
  if (!packageResult.ok) throw packageResult.error;
  const fixtureSource = `
import test from "node:test";
import assert from "node:assert/strict";
test("large Drive9 Pi fixture", () => {
  for (let line = 0; line < 7000; line += 1) console.log("drive9-pi-output-" + line.toString().padStart(5, "0"));
  assert.fail("drive9-pi-known-late-failure");
});
`;
  const fixtureResult = await env.writeFile(fixtureFile, fixtureSource);
  if (!fixtureResult.ok) throw fixtureResult.error;
  const addressedDirectory = await env.absolutePath(fixtureDirectory);
  if (!addressedDirectory.ok) throw addressedDirectory.error;
  process.env.DRIVE9_PI_DEMO_COMMAND = `npm test --prefix ${JSON.stringify(addressedDirectory.value)}`;

  let preEmissionProof: EvidenceProof | undefined;
  let compactBytes = 0;
  const execTool = createDrive9ExecTool({
    env,
    store,
    allocateIdentity,
    workspaceRevisionProvider: revisions,
    commandEnvironment,
  });
  const agent = new Agent({
    sessionId,
    streamFn: scriptedStream(),
    initialState: {
      tools: [
        execTool,
        createResultSearchTool({ store, currentSessionId: () => sessionId }),
        createResultReadTool({ store, currentSessionId: () => sessionId }),
      ],
    },
    afterToolCall: createAfterToolCallFallback({
      store,
      allocateIdentity,
      workspaceRevisionProvider: revisions,
    }),
  });
  agent.subscribe(async (event: AgentEvent) => {
    if (event.type !== "tool_execution_end" || event.toolName !== "drive9_exec") return;
    const details = event.result.details as CompactToolResultDetails;
    if (details.state !== "failed" || details.totalBytes <= 50 * 1024) {
      throw new Error("drive9_exec fixture did not produce the expected large failed result");
    }
    preEmissionProof = await evidenceProof(evidenceClient, evidenceRoot, details.resultId, details.chunkCount);
    compactBytes = event.result.content.reduce(
      (total: number, part: { type: string; text?: string }) =>
        total + (part.type === "text" && part.text !== undefined ? Buffer.byteLength(part.text, "utf8") : 0),
      0,
    );
    if (compactBytes > 8 * 1024) throw new Error("drive9_exec emitted an oversized compact result");
  });

  await agent.prompt("Run the real Drive9 evidence acceptance fixture.");
  const execMessage = agent.state.messages.find(
    (message): message is ToolResultMessage<CompactToolResultDetails> =>
      message.role === "toolResult" && message.toolName === "drive9_exec",
  );
  const searchMessage = agent.state.messages.find(
    (message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "result_search",
  );
  const readMessage = agent.state.messages.find(
    (message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "result_read",
  );
  if (execMessage === undefined || searchMessage === undefined || readMessage === undefined || preEmissionProof === undefined) {
    throw new Error("Pi agent did not execute the required result workflow");
  }
  const execDetails = execMessage.details;
  if (execDetails === undefined) throw new Error("drive9_exec tool result is missing details");
  if (textBytes(searchMessage) >= execDetails.totalBytes || textBytes(readMessage) >= execDetails.totalBytes) {
    throw new Error("bounded result tools injected the full result");
  }
  const beforeRollback = preEmissionProof;
  const tenantRootEvidenceAddress = posix.join(mountPoint, evidenceRoot.slice(1));
  const shellDeleteControl = posix.join(tenantRootEvidenceAddress, `.delete-control-${randomUUID()}`);
  const controlWrite = await env.writeFile(shellDeleteControl, "workspace delete control");
  if (!controlWrite.ok) throw controlWrite.error;
  const shellDelete = await env.exec(`/bin/rm -rf -- ${JSON.stringify(tenantRootEvidenceAddress)}`, {
    env: commandEnvironment,
    inheritEnv: false,
  });
  if (!shellDelete.ok) throw shellDelete.error;
  if (shellDelete.value.exitCode !== 0) {
    throw new Error(`workspace shell delete control failed with ${shellDelete.value.exitCode}`);
  }
  const controlExists = await env.exists(shellDeleteControl);
  if (!controlExists.ok) throw controlExists.error;
  if (controlExists.value) throw new Error("workspace shell did not delete the mount-addressed control");
  const afterShellDelete = await evidenceProof(
    evidenceClient,
    evidenceRoot,
    execDetails.resultId,
    execDetails.chunkCount,
  );
  if (JSON.stringify(afterShellDelete) !== JSON.stringify(beforeRollback)) {
    throw new Error("workspace shell changed evidence outside its mounted root");
  }
  const boundStat = await store.stat(execDetails.resultId);
  if (boundStat.workspaceBefore?.layerId !== layerId || boundStat.workspaceAfter?.layerId !== layerId) {
    throw new Error("terminal result is missing the LayerFS workspace binding");
  }
  const crashRecovery = await runCrashRecovery(baseUrl, evidenceRoot, evidenceKey, store, env, commandEnvironment);
  const fixtureExists = await env.exists(fixtureFile);
  if (!fixtureExists.ok || !fixtureExists.value) throw new Error("LayerFS fixture is not visible before rollback");
  await workspaceClient.rollbackFSLayer(layerId);
  await waitForWorkspaceRollback(env, fixtureFile);
  const afterRollback = await evidenceProof(
    evidenceClient,
    evidenceRoot,
    execDetails.resultId,
    execDetails.chunkCount,
  );
  if (JSON.stringify(afterRollback) !== JSON.stringify(beforeRollback)) {
    throw new Error("evidence revisions or bytes changed after workspace rollback");
  }
  const reboundStat = await store.stat(execDetails.resultId);
  if (JSON.stringify(reboundStat.workspaceBefore) !== JSON.stringify(boundStat.workspaceBefore)) {
    throw new Error("workspace binding changed after rollback");
  }
  const report = {
    piAgentCore: true,
    realDrive9MountDrain: true,
    evidenceIsolation: true,
    resultId: execDetails.resultId,
    resultState: execDetails.state,
    outputBytes: execDetails.totalBytes,
    compactModelBytes: compactBytes,
    searchModelBytes: textBytes(searchMessage),
    readModelBytes: textBytes(readMessage),
    manifestRevision: beforeRollback.manifest.revision,
    chunkRevisions: beforeRollback.chunks.map((chunk) => chunk.revision),
    workspaceShellDeletePreservedEvidence: true,
    rollbackPreservedEvidence: true,
    crashRecovery,
    integrationFriction: [
      "Pi shell callbacks are synchronous, so the adapter bounds queued evidence and aborts instead of claiming true child-process backpressure.",
      "Drive9 stable reads use stat/read/stat because the JavaScript SDK read API is not revision-pinned.",
      "Workspace bindings are durable observations after drain/checkpoint, not isolated snapshots.",
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await env.cleanup();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`drive9-pi demo failed: ${message}\n`);
  process.exitCode = 1;
});
