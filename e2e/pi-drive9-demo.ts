import { randomUUID } from "node:crypto";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Client } from "drive9";
import { Type } from "typebox";
import { createDrive9PiIntegration } from "../src/pi-integration.js";
import { deriveResultId } from "../src/result-id.js";
import { verifyEvidenceIsolation } from "../src/evidence-isolation.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  delete process.env[name];
  return value;
}

function toolResultText(message: unknown): string {
  if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "toolResult") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part
        ? String(part.text)
        : "",
    )
    .join("");
}

async function main(): Promise<void> {
  const baseUrl = requiredEnvironment("DRIVE9_PI_BASE_URL");
  const workspaceRoot = requiredEnvironment("DRIVE9_PI_WORKSPACE_REMOTE_ROOT");
  const evidenceRoot = requiredEnvironment("DRIVE9_PI_EVIDENCE_REMOTE_ROOT");
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

  const sessionId = `session-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const fixtureName = `.drive9-pi-${randomUUID()}.txt`;
  const largeCallId = `large-${randomUUID()}`;
  const resultId = deriveResultId({ sessionId, runId, toolCallId: largeCallId, attempt: 0 });
  const source = `${"durable customer tool output\n".repeat(256)}known-demo-marker\n`;
  const customerTool: AgentTool = {
    name: "customer_tool",
    label: "Customer Tool",
    description: "Return deterministic oversized output for the integration demo.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => ({ content: [{ type: "text", text: source }], details: undefined }),
  };
  const integration = createDrive9PiIntegration({
    workspaceClient,
    workspaceRoot,
    evidenceClient,
    evidenceRoot,
    sessionId,
    runId,
    thresholdBytes: 1024,
  });
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: fixtureName, content: "sdk-backed workspace\n" }, { id: "write-demo" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall(
        "edit",
        {
          path: fixtureName,
          edits: [{ oldText: "sdk-backed workspace", newText: "agent-loop Drive9 workspace" }],
        },
        { id: "edit-demo" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("read", { path: fixtureName }, { id: "read-demo" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("list", { path: "." }, { id: "list-demo" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("customer_tool", {}, { id: largeCallId }), { stopReason: "toolUse" }),
    fauxAssistantMessage(
      fauxToolCall("result_search", { resultId, query: "known-demo-marker" }, { id: "search-demo" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("result_read", { resultId, startLine: 250, maxLines: 10 }, { id: "result-read-demo" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  const agent = new Agent(
    integration.withAgentOptions({
      streamFn: faux.streamSimple,
      initialState: {
        systemPrompt: "",
        model: faux.getModel(),
        thinkingLevel: "off",
        tools: [customerTool],
        messages: [],
      },
    }),
  );

  try {
    await agent.prompt("Run the Drive9 integration demo.");
    const read = await integration.fileSystem.readTextFile(fixtureName);
    if (!read.ok || read.value !== "agent-loop Drive9 workspace\n") {
      throw new Error("Agent file tools did not round-trip through Drive9");
    }
    const toolResults = agent.state.messages.filter(
      (message): message is Extract<(typeof agent.state.messages)[number], { role: "toolResult" }> =>
        "role" in message && message.role === "toolResult",
    );
    const searchText = toolResultText(toolResults.find((message) => message.toolName === "result_search"));
    const pageText = toolResultText(toolResults.find((message) => message.toolName === "result_read"));
    if (!searchText.includes("known-demo-marker")) throw new Error("durable evidence search failed");
    if (!pageText.includes("durable customer tool output")) throw new Error("durable evidence read failed");
    if (agent.state.tools.some((tool) => tool.name === "bash" || tool.name === "exec")) {
      throw new Error("integration registered a shell tool");
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          workspace: { fixtureName, text: read.value },
          evidence: { resultId, searched: true, read: true },
          tools: agent.state.tools.map((tool) => tool.name),
          execution: "caller-owned; no shell tool registered",
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await integration.fileSystem.remove(fixtureName, { force: true });
    await integration.cleanup();
  }
}

await main();
