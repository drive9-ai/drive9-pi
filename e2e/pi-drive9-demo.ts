import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";
import { Client } from "drive9";
import { Drive9FileSystem } from "../src/drive9-file-system.js";
import { createDrive9ResultStore } from "../src/drive9-result-backend.js";
import { verifyEvidenceIsolation } from "../src/evidence-isolation.js";
import {
  createAfterToolCallFallback,
  createResultReadTool,
  createResultSearchTool,
} from "../src/pi-adapters.js";
import { Drive9LayerWorkspaceRevisionProvider } from "../src/workspace-revision.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  delete process.env[name];
  return value;
}

function fallbackContext(text: string): AfterToolCallContext {
  return {
    assistantMessage: {} as AfterToolCallContext["assistantMessage"],
    toolCall: { type: "toolCall", id: "demo-tool", name: "customer_tool", arguments: {} },
    args: {},
    result: { content: [{ type: "text", text }], details: undefined },
    isError: false,
    context: { systemPrompt: "", messages: [] },
  };
}

async function main(): Promise<void> {
  const baseUrl = requiredEnvironment("DRIVE9_PI_BASE_URL");
  const workspaceRoot = requiredEnvironment("DRIVE9_PI_WORKSPACE_REMOTE_ROOT");
  const evidenceRoot = requiredEnvironment("DRIVE9_PI_EVIDENCE_REMOTE_ROOT");
  const layerId = requiredEnvironment("DRIVE9_PI_LAYER_ID");
  const workspaceKey = requiredEnvironment("DRIVE9_PI_WORKSPACE_API_KEY");
  const evidenceKey = requiredEnvironment("DRIVE9_PI_EVIDENCE_API_KEY");
  const workspaceClient = new Client(baseUrl, workspaceKey);
  const evidenceClient = new Client(baseUrl, evidenceKey);

  await verifyEvidenceIsolation({
    workspaceRemoteRoot: workspaceRoot,
    evidenceRemoteRoot: evidenceRoot,
    workspaceClient,
    evidenceClient,
  });

  const fileSystem = new Drive9FileSystem({ client: workspaceClient, layerId, root: workspaceRoot });
  const revisions = new Drive9LayerWorkspaceRevisionProvider({
    client: workspaceClient,
    layerId,
    checkpointLabel: "drive9-pi-sdk-demo",
    checkpointId: () => `pi-${randomUUID()}`,
  });
  const store = createDrive9ResultStore({ client: evidenceClient, evidenceRoot });
  const fixturePath = posix.join(workspaceRoot, `.drive9-pi-${randomUUID()}.txt`);
  const written = await fileSystem.writeFile(fixturePath, "sdk-backed workspace\n");
  if (!written.ok) throw written.error;
  const read = await fileSystem.readTextFile(fixturePath);
  if (!read.ok || read.value !== "sdk-backed workspace\n") throw new Error("SDK workspace round trip failed");

  const sessionId = `session-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const fallback = createAfterToolCallFallback({
    store,
    thresholdBytes: 1024,
    allocateIdentity: ({ toolCallId }) => ({ sessionId, runId, toolCallId, attempt: 0 }),
    workspaceRevisionProvider: revisions,
  });
  const source = `${"durable customer tool output\n".repeat(256)}known-demo-marker\n`;
  const compact = await fallback(fallbackContext(source));
  if (compact === undefined) throw new Error("oversized result was not persisted");
  const resultId = (compact.details as { resultId: string }).resultId;

  const searchTool = createResultSearchTool({ store, currentSessionId: () => sessionId });
  const searched = await searchTool.execute("search-demo", { resultId, query: "known-demo-marker" });
  const matches = (searched.details as { matches: unknown[] }).matches;
  if (matches.length !== 1) throw new Error("durable evidence search failed");
  const readTool = createResultReadTool({ store, currentSessionId: () => sessionId });
  const page = await readTool.execute("read-demo", { resultId, startLine: 250, maxLines: 10, maxBytes: 4096 });

  process.stdout.write(
    `${JSON.stringify(
      {
        workspace: { fixturePath, text: read.value },
        evidence: {
          resultId,
          compactBytes: Buffer.byteLength(
            compact.content?.[0]?.type === "text" ? compact.content[0].text : "",
          ),
          matches: matches.length,
          pageBytes: Buffer.byteLength(page.content[0]?.type === "text" ? page.content[0].text : ""),
        },
        execution: "caller-owned",
      },
      null,
      2,
    )}\n`,
  );
}

await main();
