import { createBashToolDefinition, createEditToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, type BashOperations, type EditOperations, type LsOperations, type ReadOperations, type WriteOperations } from "@earendil-works/pi-coding-agent";
import { Drive9FileSystem } from "./drive9-file-system.js";
export declare const DRIVE9_STORAGE_ONLY_MESSAGE = "Drive9 is the storage backend for this Pi session and does not provide bash or host process execution";
export interface Drive9CodingAgentOperations extends ReadOperations, WriteOperations, EditOperations, LsOperations {
}
export interface CreateDrive9CodingAgentToolsOptions {
    fileSystem: Drive9FileSystem;
}
export type Drive9CodingAgentTool = ReturnType<typeof createReadToolDefinition> | ReturnType<typeof createWriteToolDefinition> | ReturnType<typeof createEditToolDefinition> | ReturnType<typeof createLsToolDefinition> | ReturnType<typeof createBashToolDefinition>;
export declare function createDrive9CodingAgentOperations(fileSystem: Drive9FileSystem): Drive9CodingAgentOperations;
export declare function createDrive9StorageOnlyBashOperations(message?: string): BashOperations;
export declare function createDrive9CodingAgentTools(options: CreateDrive9CodingAgentToolsOptions): Drive9CodingAgentTool[];
export declare function createUnavailableCodingAgentTools(root: string, message: string): Drive9CodingAgentTool[];
//# sourceMappingURL=pi-coding-agent.d.ts.map