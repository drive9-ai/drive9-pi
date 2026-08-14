import type { AfterToolCallContext, AfterToolCallResult, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { type ResultStat, type ToolResultIdentity, type ToolResultStore } from "./tool-result-types.js";
export interface ToolResultIdentityRequest {
    toolCallId: string;
    toolName: string;
    previous?: ToolResultIdentity;
}
export type ToolResultIdentityAllocator = (request: ToolResultIdentityRequest) => ToolResultIdentity | Promise<ToolResultIdentity>;
export interface CompactToolResultDetails {
    resultId: string;
    state: ResultStat["state"];
    complete: boolean;
    chunkCount: number;
    totalBytes: number;
    totalLines: number;
    sha256?: string;
    exitCode?: number;
    error?: {
        code: string;
        message: string;
    };
}
export interface AfterToolCallFallbackOptions {
    store: ToolResultStore;
    allocateIdentity: ToolResultIdentityAllocator;
    thresholdBytes?: number;
    previewBytes?: number;
}
export interface ResultToolOptions {
    store: ToolResultStore;
    currentSessionId: () => string;
}
declare const resultReadParameters: Type.TObject<{
    resultId: Type.TString;
    cursor: Type.TOptional<Type.TString>;
    startLine: Type.TOptional<Type.TInteger>;
    maxLines: Type.TOptional<Type.TInteger>;
    maxBytes: Type.TOptional<Type.TInteger>;
    allowIncomplete: Type.TOptional<Type.TBoolean>;
}>;
declare const resultSearchParameters: Type.TObject<{
    resultId: Type.TString;
    query: Type.TString;
    cursor: Type.TOptional<Type.TString>;
    caseSensitive: Type.TOptional<Type.TBoolean>;
    maxMatches: Type.TOptional<Type.TInteger>;
    contextBytes: Type.TOptional<Type.TInteger>;
    allowIncomplete: Type.TOptional<Type.TBoolean>;
}>;
export declare function createAfterToolCallFallback(options: AfterToolCallFallbackOptions): (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
export declare function createResultReadTool(options: ResultToolOptions): AgentTool<typeof resultReadParameters, unknown>;
export declare function createResultSearchTool(options: ResultToolOptions): AgentTool<typeof resultSearchParameters, unknown>;
export {};
//# sourceMappingURL=pi-adapters.d.ts.map