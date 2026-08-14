import { getOrThrow } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "drive9";
import { Drive9FileSystem, type Drive9FileSystemClient } from "./drive9-file-system.js";
import {
  createDrive9CodingAgentTools,
  createDrive9StorageOnlyBashOperations,
  createUnavailableCodingAgentTools,
  DRIVE9_STORAGE_ONLY_MESSAGE,
  type Drive9CodingAgentTool,
} from "./pi-coding-agent.js";

const DRIVE9_ROOT_FLAG = "drive9-root";
const BLOCKED_PROCESS_TOOLS = new Set(["bash", "grep", "find"]);

type ExtensionState =
  | { mode: "inactive" }
  | { mode: "drive9"; fileSystem: Drive9FileSystem; root: string }
  | { mode: "error"; message: string };

export interface Drive9PiExtensionOptions {
  defaultRoot?: string;
  createClient?: () => Drive9FileSystemClient;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configuredRoot(value: boolean | string | undefined): string | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) throw new TypeError("--drive9-root requires an absolute Drive9 path");
  const root = value.trim();
  return root.length === 0 ? undefined : root;
}

function registerTool(pi: ExtensionAPI, tool: Drive9CodingAgentTool): void {
  pi.registerTool(tool as ToolDefinition<any, any, any>);
}

export function createDrive9PiExtension(options: Drive9PiExtensionOptions = {}): ExtensionFactory {
  return (pi) => {
    const defaultRoot = options.defaultRoot ?? process.env.DRIVE9_PI_ROOT?.trim() ?? "";
    const createClient = options.createClient ?? (() => Client.defaultClient());
    let state: ExtensionState = { mode: "inactive" };

    pi.registerFlag(DRIVE9_ROOT_FLAG, {
      description: "Use an absolute Drive9 directory as Pi's workspace",
      type: "string",
      default: defaultRoot,
    });

    pi.on("session_start", async (_event, context) => {
      if (state.mode === "drive9") await state.fileSystem.cleanup();
      const requestedRoot = configuredRoot(pi.getFlag(DRIVE9_ROOT_FLAG));
      if (requestedRoot === undefined) {
        state = { mode: "inactive" };
        context.ui.setStatus("drive9", undefined);
        return;
      }

      try {
        const fileSystem = new Drive9FileSystem({ client: createClient(), root: requestedRoot });
        if (fileSystem.root === "/") throw new TypeError("--drive9-root must not expose the tenant root");
        const rootInfo = getOrThrow(await fileSystem.fileInfo(fileSystem.root));
        if (rootInfo.kind !== "directory") throw new TypeError("--drive9-root must identify an existing directory");
        state = { mode: "drive9", fileSystem, root: fileSystem.root };
        for (const tool of createDrive9CodingAgentTools({ fileSystem })) registerTool(pi, tool);
        context.ui.setStatus("drive9", `Drive9: ${fileSystem.root}`);
      } catch (error) {
        const message = `Drive9 workspace initialization failed: ${errorMessage(error)}`;
        state = { mode: "error", message };
        for (const tool of createUnavailableCodingAgentTools(process.cwd(), message)) registerTool(pi, tool);
        context.ui.setStatus("drive9", "Drive9: unavailable");
        context.ui.notify(message, "error");
      }
    });

    pi.on("tool_call", (event) => {
      if (state.mode === "inactive" || !BLOCKED_PROCESS_TOOLS.has(event.toolName)) return;
      return {
        block: true,
        reason: state.mode === "error" ? state.message : DRIVE9_STORAGE_ONLY_MESSAGE,
      };
    });

    pi.on("user_bash", () => {
      if (state.mode === "inactive") return;
      const message = state.mode === "error" ? state.message : DRIVE9_STORAGE_ONLY_MESSAGE;
      return { operations: createDrive9StorageOnlyBashOperations(message) };
    });

    pi.on("before_agent_start", (event) => {
      if (state.mode !== "drive9") return;
      const localLine = `Current working directory: ${event.systemPromptOptions.cwd}`;
      const drive9Line = `Current working directory: ${state.root} (Drive9 SDK workspace)`;
      const boundary =
        "Drive9 is storage-only in this session. Use read, write, edit, and ls. Bash, grep, find, and host filesystem access are unavailable.";
      const systemPrompt = event.systemPrompt.includes(localLine)
        ? event.systemPrompt.replace(localLine, drive9Line)
        : `${event.systemPrompt}\n\n${drive9Line}`;
      return { systemPrompt: `${systemPrompt}\n\n${boundary}` };
    });

    pi.on("session_shutdown", async (_event, context) => {
      if (state.mode === "drive9") await state.fileSystem.cleanup();
      state = { mode: "inactive" };
      context.ui.setStatus("drive9", undefined);
    });
  };
}

export default function drive9PiExtension(
  ...args: Parameters<ExtensionFactory>
): ReturnType<ExtensionFactory> {
  return createDrive9PiExtension()(...args);
}
