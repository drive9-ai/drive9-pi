import { posix } from "node:path";
import { getOrThrow } from "@earendil-works/pi-agent-core";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type EditOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Drive9FileSystem } from "./drive9-file-system.js";

export const DRIVE9_STORAGE_ONLY_MESSAGE =
  "Drive9 is the storage backend for this Pi session and does not provide bash or host process execution";

export interface Drive9CodingAgentOperations
  extends ReadOperations,
    WriteOperations,
    EditOperations,
    LsOperations {}

export interface CreateDrive9CodingAgentToolsOptions {
  fileSystem: Drive9FileSystem;
}

export type Drive9CodingAgentTool =
  | ReturnType<typeof createReadToolDefinition>
  | ReturnType<typeof createWriteToolDefinition>
  | ReturnType<typeof createEditToolDefinition>
  | ReturnType<typeof createLsToolDefinition>
  | ReturnType<typeof createBashToolDefinition>;

function supportedImageMimeType(path: string): string | null {
  switch (posix.extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return null;
  }
}

export function createDrive9CodingAgentOperations(
  fileSystem: Drive9FileSystem,
): Drive9CodingAgentOperations {
  return {
    readFile: async (absolutePath) => Buffer.from(getOrThrow(await fileSystem.readBinaryFile(absolutePath))),
    access: async (absolutePath) => {
      const info = getOrThrow(await fileSystem.fileInfo(absolutePath));
      if (info.kind === "directory") throw new Error(`Path is a directory: ${absolutePath}`);
      if (info.kind === "symlink") throw new Error(`Symlink access is not supported: ${absolutePath}`);
    },
    detectImageMimeType: async (absolutePath) => supportedImageMimeType(absolutePath),
    writeFile: async (absolutePath, content) => {
      getOrThrow(await fileSystem.writeFile(absolutePath, content));
    },
    mkdir: async (directory) => {
      getOrThrow(await fileSystem.createDir(directory, { recursive: true }));
    },
    exists: async (absolutePath) => getOrThrow(await fileSystem.exists(absolutePath)),
    stat: async (absolutePath) => {
      const info = getOrThrow(await fileSystem.fileInfo(absolutePath));
      return { isDirectory: () => info.kind === "directory" };
    },
    readdir: async (absolutePath) =>
      getOrThrow(await fileSystem.listDir(absolutePath)).map((entry) => entry.name),
  };
}

export function createDrive9StorageOnlyBashOperations(
  message = DRIVE9_STORAGE_ONLY_MESSAGE,
): BashOperations {
  return {
    exec: async () => {
      throw new Error(message);
    },
  };
}

function withDrive9EditCallRenderer(
  tool: ReturnType<typeof createEditToolDefinition>,
): ReturnType<typeof createEditToolDefinition> {
  return {
    ...tool,
    renderCall(args, theme) {
      const path = typeof args.path === "string" && args.path.length > 0 ? args.path : "...";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path)}`,
        0,
        0,
      );
    },
  };
}

function storageOnlyBash(root: string, message: string): ReturnType<typeof createBashToolDefinition> {
  return {
    ...createBashToolDefinition(root, {
      operations: createDrive9StorageOnlyBashOperations(message),
      exposeSessionEnvironment: false,
    }),
    description: message,
    promptSnippet: "Bash and host process execution are unavailable in Drive9 storage-only mode",
    promptGuidelines: ["Do not use bash, grep, or find in Drive9 storage-only mode."],
  };
}

export function createDrive9CodingAgentTools(
  options: CreateDrive9CodingAgentToolsOptions,
): Drive9CodingAgentTool[] {
  const { fileSystem } = options;
  const operations = createDrive9CodingAgentOperations(fileSystem);
  const tools: Drive9CodingAgentTool[] = [
    createReadToolDefinition(fileSystem.root, { operations }),
    createWriteToolDefinition(fileSystem.root, { operations }),
    withDrive9EditCallRenderer(createEditToolDefinition(fileSystem.root, { operations })),
    createLsToolDefinition(fileSystem.root, { operations }),
    storageOnlyBash(fileSystem.root, DRIVE9_STORAGE_ONLY_MESSAGE),
  ];
  return tools;
}

export function createUnavailableCodingAgentTools(root: string, message: string): Drive9CodingAgentTool[] {
  const unavailable = <Tool extends Drive9CodingAgentTool>(tool: Tool): Tool =>
    ({
      ...tool,
      description: message,
      promptSnippet: message,
      execute: async () => {
        throw new Error(message);
      },
    }) as Tool;
  const tools: Drive9CodingAgentTool[] = [
    createReadToolDefinition(root),
    createWriteToolDefinition(root),
    withDrive9EditCallRenderer(createEditToolDefinition(root)),
    createLsToolDefinition(root),
    storageOnlyBash(root, message),
  ];
  return tools.map((tool) => unavailable(tool));
}
