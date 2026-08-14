import { type AgentHarnessTool, type AgentOptions, type AgentTool, type ExecutionEnv, type ExecutionToolContext, type ReadToolOptions, type Shell } from "@earendil-works/pi-agent-core";
import { Drive9FileSystem, type Drive9FileSystemClient } from "./drive9-file-system.js";
import { type Drive9ResultClient } from "./drive9-result-backend.js";
import type { PersistentToolResultStore } from "./tool-result-store.js";
type AfterToolCall = NonNullable<AgentOptions["afterToolCall"]>;
export interface Drive9PiIntegrationOptions {
    workspaceClient: Drive9FileSystemClient;
    workspaceRoot: string;
    evidenceClient: Drive9ResultClient;
    evidenceRoot: string;
    sessionId: string;
    runId: string;
    thresholdBytes?: number;
    previewBytes?: number;
    readTool?: ReadToolOptions;
    shell?: Shell;
    harnessTools?: readonly AgentHarnessTool<ExecutionToolContext>[];
}
export interface CreateDrive9FileToolsOptions {
    fileSystem: Drive9FileSystem;
    readTool?: ReadToolOptions;
}
export interface Drive9PiIntegration {
    fileSystem: Drive9FileSystem;
    resultStore: PersistentToolResultStore;
    executionEnv: ExecutionEnv;
    tools: AgentTool[];
    afterToolCall: AfterToolCall;
    withAgentOptions(options: AgentOptions): AgentOptions;
    cleanup(): Promise<void>;
}
/** Return Pi file tools already bound to the supplied Drive9 filesystem. */
export declare function createDrive9FileTools(options: CreateDrive9FileToolsOptions): AgentTool[];
export declare function chainAfterToolCall(first: AfterToolCall, second: AfterToolCall): AfterToolCall;
export declare function createDrive9PiIntegration(options: Drive9PiIntegrationOptions): Drive9PiIntegration;
export {};
//# sourceMappingURL=pi-integration.d.ts.map