import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { getOrThrow } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
  SourceInfo,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Client } from "drive9";
import { Drive9FileSystem, type Drive9FileSystemClient } from "./drive9-file-system.js";
import {
  createDrive9CodingAgentTools,
  createDrive9StorageOnlyBashOperations,
  createUnavailableCodingAgentTools,
  DRIVE9_STORAGE_ONLY_MESSAGE,
  type Drive9CodingAgentTool,
} from "./pi-coding-agent.js";
import {
  DRIVE9_COMMAND_DESCRIPTION,
  registerDrive9Command,
} from "./pi-extension-commands.js";
import {
  DRIVE9_EXTENSION_CONFIG_VERSION,
  getDrive9ProjectConfigPath,
  getDrive9ProjectTrustMarkerPath,
  resolveDrive9ExtensionConfig,
  writeDrive9ProjectConfig,
  type Drive9ExtensionConfigIO,
  type Drive9ExtensionConfigSource,
  type ResolvedDrive9ExtensionConfig,
} from "./pi-extension-config.js";

const DRIVE9_ROOT_FLAG = "drive9-root";
const NO_DRIVE9_FLAG = "no-drive9";
const DRIVE9_FILE_TOOL_NAMES = ["read", "write", "edit", "ls"] as const;
const DRIVE9_BOUNDARY_TOOL_NAMES = new Set([
  ...DRIVE9_FILE_TOOL_NAMES,
  "bash",
  "grep",
  "find",
]);
const BLOCKED_PROCESS_TOOLS = new Set(["bash", "grep", "find"]);
const INIT_ERROR_PREFIX = "DRIVE9_INIT_FAILED";

export type Drive9ExtensionState =
  | { mode: "inactive"; reason: "unconfigured" }
  | { mode: "disabled"; source: "no-drive9" | "project" | "none" }
  | {
      mode: "checking";
      root: string;
      source: Exclude<Drive9ExtensionConfigSource, "none" | "no-drive9">;
    }
  | {
      mode: "drive9";
      fileSystem: Drive9FileSystem;
      root: string;
      source: Exclude<Drive9ExtensionConfigSource, "none" | "no-drive9">;
      checkedAt: string;
    }
  | {
      mode: "error";
      message: string;
      source: Exclude<Drive9ExtensionConfigSource, "none">;
      root?: string;
    };

export interface Drive9PiExtensionOptions {
  defaultRoot?: string;
  createClient?: () => Drive9FileSystemClient;
  environment?: Readonly<Record<string, string | undefined>>;
  configIO?: Drive9ExtensionConfigIO;
}

interface Drive9ToolOwnership {
  parameters: ReadonlyMap<string, unknown>;
  sourceInfo: SourceInfo;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerTool(pi: ExtensionAPI, tool: Drive9CodingAgentTool): void {
  pi.registerTool(tool as ToolDefinition<any, any, any>);
}

function isDrive9FileTool(tool: Drive9CodingAgentTool): boolean {
  return DRIVE9_FILE_TOOL_NAMES.some((name) => name === tool.name);
}

function sameSourceInfo(left: SourceInfo, right: SourceInfo): boolean {
  return (
    left.path === right.path &&
    left.source === right.source &&
    left.scope === right.scope &&
    left.origin === right.origin &&
    left.baseDir === right.baseDir
  );
}

function stateUsesDrive9Boundary(state: Drive9ExtensionState): boolean {
  return state.mode === "checking" || state.mode === "drive9" || state.mode === "error";
}

function sourceLabel(source: Drive9ExtensionConfigSource): string {
  switch (source) {
    case "cli":
      return "--drive9-root";
    case "env":
      return "DRIVE9_PI_ROOT";
    case "project":
      return "project config";
    case "programmatic":
      return "programmatic default";
    case "no-drive9":
      return "--no-drive9";
    case "none":
      return "none";
  }
}

async function validateWorkspace(
  client: Drive9FileSystemClient,
  root: string,
): Promise<Drive9FileSystem> {
  const fileSystem = new Drive9FileSystem({ client, root });
  const rootInfo = getOrThrow(await fileSystem.fileInfo(fileSystem.root));
  if (rootInfo.kind !== "directory") {
    throw new TypeError("Drive9 root must identify an existing directory");
  }
  getOrThrow(await fileSystem.listDir(fileSystem.root));
  return fileSystem;
}

function statusText(
  state: Drive9ExtensionState,
  context: ExtensionCommandContext,
  activeTools: readonly string[],
): { message: string; level: "info" | "warning" | "error" } {
  const configPath = getDrive9ProjectConfigPath(context.cwd);
  const markerPath = getDrive9ProjectTrustMarkerPath(context.cwd);
  const trust = context.isProjectTrusted()
    ? "Pi project trust: trusted"
    : "Pi project trust: untrusted; project config is ignored";
  const activeFileTools = DRIVE9_FILE_TOOL_NAMES.filter((name) => activeTools.includes(name));
  switch (state.mode) {
    case "inactive":
      return {
        message: [
          "Drive9: inactive",
          `Config: ${configPath}`,
          trust,
          `Trust marker required: ${markerPath}`,
          "Tools: Pi local tools",
          "Next: /drive9 setup",
        ].join("\n"),
        level: "info",
      };
    case "disabled":
      return {
        message: [
          "Drive9: disabled",
          `Source: ${sourceLabel(state.source)}`,
          `Config: ${configPath}`,
          trust,
          `Trust marker required: ${markerPath}`,
          "Tools: Pi local tools",
          "Next: /drive9 setup",
        ].join("\n"),
        level: "info",
      };
    case "checking":
      return {
        message: [
          "Drive9: checking",
          `Root: ${state.root}`,
          `Source: ${sourceLabel(state.source)}`,
          `Config: ${configPath}`,
          trust,
          `Trust marker required: ${markerPath}`,
        ].join("\n"),
        level: "info",
      };
    case "drive9":
      return {
        message: [
          "Drive9: active",
          `Root: ${state.root}`,
          `Source: ${sourceLabel(state.source)}`,
          `Config: ${configPath}`,
          trust,
          `Trust marker required: ${markerPath}`,
          "Auth: configured",
          "Mappings: read, write, edit, ls -> Drive9",
          `Active filesystem tools: ${activeFileTools.length > 0 ? activeFileTools.join(", ") : "none"}`,
          "Model tools blocked: bash, grep, find",
          "Interactive !: Drive9 refusal is subject to Pi interceptor load order",
          `Last check: ${state.checkedAt}`,
        ].join("\n"),
        level: "info",
      };
    case "error":
      return {
        message: [
          "Drive9: unavailable",
          ...(state.root === undefined ? [] : [`Root: ${state.root}`]),
          `Source: ${sourceLabel(state.source)}`,
          `Config: ${configPath}`,
          trust,
          `Trust marker required: ${markerPath}`,
          `Error: ${state.message}`,
          "Safety: local fallback is blocked",
          "Recovery: fix the configuration or credentials, then run /reload",
        ].join("\n"),
        level: "error",
      };
  }
}

function resultCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function verifyWrite(fileSystem: Drive9FileSystem): Promise<void> {
  const temporaryPath = getOrThrow(
    await fileSystem.createTempFile({ prefix: "verify-", suffix: ".txt" }),
  );
  let operationError: unknown;
  let cleanupError: unknown;
  try {
    const expected = `drive9-pi verification ${randomUUID()}\n`;
    getOrThrow(await fileSystem.writeFile(temporaryPath, expected));
    const actual = getOrThrow(await fileSystem.readTextFile(temporaryPath));
    if (actual !== expected) throw new Error("Drive9 write verification read back different content");
  } catch (error) {
    operationError = error;
  } finally {
    const removed = await fileSystem.remove(temporaryPath, { force: true });
    if (!removed.ok) cleanupError = removed.error;
  }
  if (operationError !== undefined) {
    if (cleanupError !== undefined) {
      throw new Error(
        `${errorMessage(operationError)}; temporary file cleanup failed at ${temporaryPath}: ${errorMessage(cleanupError)}`,
      );
    }
    throw operationError;
  }
  if (cleanupError !== undefined) {
    throw new Error(`Temporary file cleanup failed at ${temporaryPath}: ${errorMessage(cleanupError)}`);
  }
}

export function createDrive9PiExtension(options: Drive9PiExtensionOptions = {}): ExtensionFactory {
  return (pi) => {
    const createClient = options.createClient ?? (() => Client.defaultClient());
    const environment = options.environment ?? process.env;
    let state: Drive9ExtensionState = { mode: "inactive", reason: "unconfigured" };
    let toolOwnership: Drive9ToolOwnership | undefined;
    let previousBoundaryActiveTools: string[] | undefined;

    function captureBoundaryActiveTools(): void {
      previousBoundaryActiveTools ??= pi
        .getActiveTools()
        .filter((name) => DRIVE9_BOUNDARY_TOOL_NAMES.has(name));
    }

    function deactivateBoundaryTools(): void {
      pi.setActiveTools(
        pi.getActiveTools().filter((name) => !DRIVE9_BOUNDARY_TOOL_NAMES.has(name)),
      );
    }

    function activateDrive9FileTools(): void {
      const nonBoundaryTools = pi
        .getActiveTools()
        .filter((name) => !DRIVE9_BOUNDARY_TOOL_NAMES.has(name));
      const activeFileTools = (previousBoundaryActiveTools ?? []).filter((name) =>
        DRIVE9_FILE_TOOL_NAMES.some((fileToolName) => fileToolName === name),
      );
      const defaultFileToolsWereActive = ["read", "write", "edit"].every((name) =>
        activeFileTools.includes(name),
      );
      if (defaultFileToolsWereActive && !activeFileTools.includes("ls")) {
        activeFileTools.push("ls");
      }
      pi.setActiveTools([...new Set([...nonBoundaryTools, ...activeFileTools])]);
    }

    function restoreBoundaryTools(): void {
      if (previousBoundaryActiveTools === undefined) return;
      const nonBoundaryTools = pi
        .getActiveTools()
        .filter((name) => !DRIVE9_BOUNDARY_TOOL_NAMES.has(name));
      pi.setActiveTools([...new Set([...nonBoundaryTools, ...previousBoundaryActiveTools])]);
      previousBoundaryActiveTools = undefined;
    }

    function drive9CommandSourceInfo(): SourceInfo {
      const commands = pi
        .getCommands()
        .filter(
          (command) =>
            command.source === "extension" &&
            command.description === DRIVE9_COMMAND_DESCRIPTION,
        );
      if (commands.length !== 1) {
        throw new Error(
          `could not uniquely identify the Drive9 extension source (${commands.length} matching commands)`,
        );
      }
      return commands[0]!.sourceInfo;
    }

    function ownershipMismatches(
      ownership: Drive9ToolOwnership,
      requiredToolName?: string,
    ): string[] {
      const effectiveTools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
      return DRIVE9_FILE_TOOL_NAMES.filter((name) => {
        const effective = effectiveTools.get(name);
        if (effective === undefined) return name === requiredToolName;
        return (
          effective.parameters !== ownership.parameters.get(name) ||
          !sameSourceInfo(effective.sourceInfo, ownership.sourceInfo)
        );
      });
    }

    function verifyToolOwnership(tools: readonly Drive9CodingAgentTool[]): Drive9ToolOwnership {
      const ownership: Drive9ToolOwnership = {
        parameters: new Map(tools.map((tool) => [tool.name, tool.parameters])),
        sourceInfo: drive9CommandSourceInfo(),
      };
      const mismatches = ownershipMismatches(ownership);
      if (mismatches.length > 0) {
        throw new Error(
          `Drive9 does not own the effective ${mismatches.join(", ")} tool definition${mismatches.length === 1 ? "" : "s"}; disable the conflicting extension or SDK tool`,
        );
      }
      return ownership;
    }

    function installUnavailableFileSystemTools(context: ExtensionContext, message: string): void {
      for (const tool of createUnavailableCodingAgentTools(context.cwd, message)) {
        if (isDrive9FileTool(tool)) registerTool(pi, tool);
      }
    }

    function enterUnavailableState(
      resolved: Extract<ResolvedDrive9ExtensionConfig, { status: "active" | "error" }>,
      context: ExtensionContext,
      error: unknown,
    ): string {
      const message = `${INIT_ERROR_PREFIX}: ${errorMessage(error)}`;
      captureBoundaryActiveTools();
      toolOwnership = undefined;
      state = {
        mode: "error",
        message,
        source: resolved.source,
        ...(resolved.status === "active" ? { root: resolved.root } : {}),
      };
      installUnavailableFileSystemTools(context, message);
      deactivateBoundaryTools();
      context.ui.setStatus("drive9", "Drive9: unavailable");
      if (context.hasUI) context.ui.notify(message, "error");
      return message;
    }

    pi.registerFlag(DRIVE9_ROOT_FLAG, {
      description: "Use an absolute Drive9 directory as Pi's workspace",
      type: "string",
    });
    pi.registerFlag(NO_DRIVE9_FLAG, {
      description: "Disable Drive9 for this invocation",
      type: "boolean",
      default: false,
    });

    registerDrive9Command(pi, {
      status: async (context) => {
        const status = statusText(state, context, pi.getActiveTools());
        context.ui.notify(status.message, status.level);
      },
      setup: async (context, rootArgument) => {
        if (!context.hasUI) {
          throw new Error("/drive9 setup requires TUI or RPC UI; use --drive9-root for headless runs");
        }
        if (!context.isProjectTrusted()) {
          context.ui.notify(
            "Drive9 setup will not write an untrusted project. Use /trust, then restart Pi (or restart with --approve).",
            "error",
          );
          return;
        }

        const currentRoot =
          state.mode === "drive9" || state.mode === "checking" || state.mode === "error"
            ? state.root
            : undefined;
        const suggestedRoot = currentRoot ?? `/workspaces/${basename(context.cwd)}`;
        const enteredRoot =
          rootArgument ?? (await context.ui.input("Drive9 workspace root", suggestedRoot));
        if (enteredRoot === undefined) return;
        const requestedRoot = enteredRoot.trim().length === 0 ? suggestedRoot : enteredRoot.trim();

        let fileSystem: Drive9FileSystem | undefined;
        try {
          const client = createClient();
          try {
            fileSystem = await validateWorkspace(client, requestedRoot);
          } catch (error) {
            if (resultCode(error) !== "not_found") throw error;
            const normalized = new Drive9FileSystem({ client, root: requestedRoot }).root;
            const create = await context.ui.confirm(
              "Create Drive9 workspace?",
              `${normalized} does not exist. Create it? Its parent directory must already exist.`,
            );
            if (!create) return;
            await client.mkdir(normalized, 0o755);
            fileSystem = await validateWorkspace(client, normalized);
          }

          const configPath = getDrive9ProjectConfigPath(context.cwd);
          const confirmed = await context.ui.confirm(
            "Enable Drive9 for this project?",
            `Write ${configPath}\nRoot: ${fileSystem.root}`,
          );
          if (!confirmed) return;

          await context.waitForIdle();
          await writeDrive9ProjectConfig({
            cwd: context.cwd,
            trusted: context.isProjectTrusted(),
            config: {
              version: DRIVE9_EXTENSION_CONFIG_VERSION,
              enabled: true,
              root: fileSystem.root,
            },
            ...(options.configIO === undefined ? {} : { io: options.configIO }),
          });
          context.ui.notify(`Drive9 configured: ${fileSystem.root}`, "info");
          await context.reload();
          return;
        } catch (error) {
          context.ui.notify(`Drive9 setup failed: ${errorMessage(error)}`, "error");
        } finally {
          await fileSystem?.cleanup();
        }
      },
      disable: async (context) => {
        if (!context.hasUI) {
          throw new Error("/drive9 disable requires TUI or RPC UI; use --no-drive9 for headless runs");
        }
        if (!context.isProjectTrusted()) {
          context.ui.notify(
            "Drive9 disable will not write an untrusted project. Use /trust, then restart Pi (or restart with --approve).",
            "error",
          );
          return;
        }
        if (state.mode === "inactive" || state.mode === "disabled") {
          context.ui.notify("Drive9 is already inactive for this project", "info");
          return;
        }
        if (state.source === "cli" || state.source === "env") {
          context.ui.notify(
            `Drive9 is enabled by ${sourceLabel(state.source)}. Restart with --no-drive9 or remove that override.`,
            "warning",
          );
          return;
        }
        if (state.root === undefined) {
          context.ui.notify("Drive9 root is unavailable; fix or remove the project config manually", "error");
          return;
        }
        const confirmed = await context.ui.confirm(
          "Disable Drive9?",
          `Restore Pi local tools for this project?\nRoot retained: ${state.root}`,
        );
        if (!confirmed) return;
        await context.waitForIdle();
        await writeDrive9ProjectConfig({
          cwd: context.cwd,
          trusted: context.isProjectTrusted(),
          config: {
            version: DRIVE9_EXTENSION_CONFIG_VERSION,
            enabled: false,
            root: state.root,
          },
          ...(options.configIO === undefined ? {} : { io: options.configIO }),
        });
        context.ui.notify("Drive9 disabled; restoring Pi local tools", "info");
        await context.reload();
        return;
      },
      verify: async (context, write) => {
        if (state.mode !== "drive9") {
          context.ui.notify("Drive9 is not active. Run /drive9 setup first.", "error");
          return;
        }
        context.ui.setStatus("drive9-verify", "Drive9: verifying…");
        let fileSystem: Drive9FileSystem | undefined;
        try {
          fileSystem = await validateWorkspace(createClient(), state.root);
          if (write) await verifyWrite(fileSystem);
          state = { ...state, checkedAt: new Date().toISOString() };
          context.ui.notify(
            `Drive9 ${write ? "write" : "read"} verification succeeded: ${state.root}`,
            "info",
          );
        } catch (error) {
          context.ui.notify(`Drive9 verification failed: ${errorMessage(error)}`, "error");
        } finally {
          await fileSystem?.cleanup();
          context.ui.setStatus("drive9-verify", undefined);
        }
      },
    });

    async function failInitialization(
      resolved: Extract<ResolvedDrive9ExtensionConfig, { status: "active" | "error" }>,
      context: ExtensionContext,
      error: unknown,
    ): Promise<void> {
      const message = enterUnavailableState(resolved, context, error);
      if (!context.hasUI) throw new Error(message, { cause: error });
    }

    pi.on("session_start", async (_event, context) => {
      if (state.mode === "drive9") await state.fileSystem.cleanup();
      const noDrive9 = pi.getFlag(NO_DRIVE9_FLAG);
      const cliRoot = pi.getFlag(DRIVE9_ROOT_FLAG);
      const resolved = await resolveDrive9ExtensionConfig({
        cwd: context.cwd,
        projectTrusted: context.isProjectTrusted(),
        environment,
        ...(noDrive9 === undefined ? {} : { noDrive9 }),
        ...(cliRoot === undefined ? {} : { cliRoot }),
        ...(options.defaultRoot === undefined || options.defaultRoot.trim().length === 0
          ? {}
          : { defaultRoot: options.defaultRoot }),
        ...(options.configIO === undefined ? {} : { io: options.configIO }),
      });

      if (resolved.status === "inactive") {
        toolOwnership = undefined;
        if (resolved.reason === "disabled") {
          state = { mode: "disabled", source: resolved.source };
          context.ui.setStatus("drive9", "Drive9: off");
        } else {
          state = { mode: "inactive", reason: "unconfigured" };
          context.ui.setStatus("drive9", undefined);
        }
        return;
      }
      if (resolved.status === "error") {
        await failInitialization(resolved, context, resolved.error);
        return;
      }

      captureBoundaryActiveTools();
      toolOwnership = undefined;
      state = { mode: "checking", root: resolved.root, source: resolved.source };
      context.ui.setStatus("drive9", "Drive9: checking…");
      let fileSystem: Drive9FileSystem | undefined;
      try {
        fileSystem = await validateWorkspace(createClient(), resolved.root);
        const tools = createDrive9CodingAgentTools({ fileSystem }).filter(isDrive9FileTool);
        for (const tool of tools) registerTool(pi, tool);
        const verifiedOwnership = verifyToolOwnership(tools);
        activateDrive9FileTools();
        toolOwnership = verifiedOwnership;
        state = {
          mode: "drive9",
          fileSystem,
          root: fileSystem.root,
          source: resolved.source,
          checkedAt: new Date().toISOString(),
        };
        context.ui.setStatus("drive9", `Drive9: ${fileSystem.root}`);
      } catch (error) {
        await fileSystem?.cleanup();
        await failInitialization(resolved, context, error);
      }
    });

    pi.on("tool_call", async (event, context) => {
      if (state.mode === "checking" || state.mode === "error") {
        if (!DRIVE9_BOUNDARY_TOOL_NAMES.has(event.toolName)) return;
        return {
          block: true,
          reason: state.mode === "error" ? state.message : DRIVE9_STORAGE_ONLY_MESSAGE,
        };
      }
      if (state.mode !== "drive9") return;
      if (BLOCKED_PROCESS_TOOLS.has(event.toolName)) {
        return { block: true, reason: DRIVE9_STORAGE_ONLY_MESSAGE };
      }
      if (!DRIVE9_FILE_TOOL_NAMES.some((name) => name === event.toolName)) return;

      const mismatches =
        toolOwnership === undefined
          ? [...DRIVE9_FILE_TOOL_NAMES]
          : ownershipMismatches(toolOwnership, event.toolName);
      if (mismatches.length === 0) return;

      const activeState = state;
      const ownershipError = new Error(
        `Drive9 lost ownership of the effective ${mismatches.join(", ")} tool definition${mismatches.length === 1 ? "" : "s"}; local fallback remains blocked`,
      );
      const message = enterUnavailableState(
        {
          status: "active",
          source: activeState.source,
          root: activeState.root,
        },
        context,
        ownershipError,
      );
      try {
        await activeState.fileSystem.cleanup();
      } catch {}
      return { block: true, reason: message };
    });

    pi.on("user_bash", () => {
      if (!stateUsesDrive9Boundary(state)) return;
      const message = state.mode === "error" ? state.message : DRIVE9_STORAGE_ONLY_MESSAGE;
      return { operations: createDrive9StorageOnlyBashOperations(message) };
    });

    pi.on("before_agent_start", (event) => {
      if (state.mode === "error") {
        const boundary =
          "Drive9 is unavailable. Standard filesystem and process tools are blocked; do not access or modify the host filesystem.";
        return { systemPrompt: `${event.systemPrompt}\n\n${boundary}\n${state.message}` };
      }
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
      try {
        if (state.mode === "drive9") await state.fileSystem.cleanup();
      } finally {
        restoreBoundaryTools();
        toolOwnership = undefined;
        state = { mode: "inactive", reason: "unconfigured" };
        context.ui.setStatus("drive9", undefined);
        context.ui.setStatus("drive9-verify", undefined);
      }
    });
  };
}

export default function drive9PiExtension(
  ...args: Parameters<ExtensionFactory>
): ReturnType<ExtensionFactory> {
  return createDrive9PiExtension()(...args);
}
