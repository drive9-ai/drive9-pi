import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { deriveResultId } from "./result-id.js";
import {
  ResultStoreError,
  type ResultStat,
  type ToolResultIdentity,
  type ToolResultStore,
  type WorkspaceRevision,
} from "./tool-result-types.js";
import type { WorkspaceRevisionProvider } from "./workspace-revision.js";

const MEDIA_TYPE = "text/plain; charset=utf-8" as const;
const MAX_CHUNK_BYTES = 64 * 1024;
const DEFAULT_PREVIEW_BYTES = 8 * 1024;
const MAX_PREVIEW_BYTES = 8 * 1024;
const FALLBACK_THRESHOLD_BYTES = 50 * 1024;
const MAX_MODEL_RESULT_BYTES = 64 * 1024;
const MAX_RESULT_READ_TEXT_BYTES = 56 * 1024;
const RESULT_ID_PATTERN = "^r1_[0-9a-f]{64}$";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface ToolResultIdentityRequest {
  toolCallId: string;
  toolName: string;
  previous?: ToolResultIdentity;
}

export type ToolResultIdentityAllocator = (
  request: ToolResultIdentityRequest,
) => ToolResultIdentity | Promise<ToolResultIdentity>;

export interface CompactToolResultDetails {
  resultId: string;
  state: ResultStat["state"];
  complete: boolean;
  chunkCount: number;
  totalBytes: number;
  totalLines: number;
  sha256?: string;
  exitCode?: number;
  error?: { code: string; message: string };
  workspaceBefore?: WorkspaceRevision;
  workspaceAfter?: WorkspaceRevision;
}

export interface AfterToolCallFallbackOptions {
  store: ToolResultStore;
  allocateIdentity: ToolResultIdentityAllocator;
  workspaceRevisionProvider?: WorkspaceRevisionProvider;
  thresholdBytes?: number;
  previewBytes?: number;
}

export interface ResultToolOptions {
  store: ToolResultStore;
  currentSessionId: () => string;
}

const resultReadParameters = Type.Object(
  {
    resultId: Type.String({ pattern: RESULT_ID_PATTERN }),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    startLine: Type.Optional(Type.Integer({ minimum: 0 })),
    maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULT_READ_TEXT_BYTES })),
    allowIncomplete: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const resultSearchParameters = Type.Object(
  {
    resultId: Type.String({ pattern: RESULT_ID_PATTERN }),
    query: Type.String({ minLength: 1, maxLength: 4096 }),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    caseSensitive: Type.Optional(Type.Boolean()),
    maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    contextBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: 4096 })),
    allowIncomplete: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

function errorValue(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : String(value));
}

function configuredInteger(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? defaultValue;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new ResultStoreError("invalid", `${label} must be between ${minimum} and ${maximum}`);
  }
  return selected;
}

function validIdentity(identity: ToolResultIdentity, request: ToolResultIdentityRequest): ToolResultIdentity {
  deriveResultId(identity);
  if (identity.toolCallId !== request.toolCallId) {
    throw new ResultStoreError("invalid", "identity allocator changed the tool call id");
  }
  if (request.previous !== undefined) {
    if (identity.sessionId !== request.previous.sessionId || identity.runId !== request.previous.runId) {
      throw new ResultStoreError("invalid", "identity allocator changed session or run during retry");
    }
    if (identity.attempt <= request.previous.attempt) {
      throw new ResultStoreError("invalid", "identity allocator did not advance the retry attempt");
    }
  }
  return identity;
}

async function allocateIdentity(
  allocator: ToolResultIdentityAllocator,
  request: ToolResultIdentityRequest,
): Promise<ToolResultIdentity> {
  return validIdentity(await allocator(request), request);
}

function splitUtf8(value: string, maxBytes = MAX_CHUNK_BYTES): Uint8Array[] {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length === 0) return [];
  const chunks: Uint8Array[] = [];
  let start = 0;
  while (start < encoded.length) {
    let end = Math.min(start + maxBytes, encoded.length);
    if (end < encoded.length) {
      while (end > start && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) <= 0xbf) end -= 1;
      if (end === start) throw new ResultStoreError("invalid", "UTF-8 chunk boundary is invalid");
    }
    const chunk = encoded.subarray(start, end);
    UTF8_DECODER.decode(chunk);
    chunks.push(Uint8Array.from(chunk));
    start = end;
  }
  return chunks;
}

function utf8Prefix(bytes: Uint8Array, maxBytes: number): string {
  let end = Math.min(bytes.byteLength, maxBytes);
  while (end > 0) {
    try {
      return UTF8_DECODER.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function boundedMessage(value: string, maxBytes = 4096): string {
  return utf8Prefix(Buffer.from(value, "utf8"), maxBytes);
}

function statDetails(stat: ResultStat): CompactToolResultDetails {
  return {
    resultId: stat.resultId,
    state: stat.state,
    complete: stat.complete,
    chunkCount: stat.chunkCount,
    totalBytes: stat.totalBytes,
    totalLines: stat.totalLines,
    ...(stat.sha256 === undefined ? {} : { sha256: stat.sha256 }),
    ...(stat.exitCode === undefined ? {} : { exitCode: stat.exitCode }),
    ...(stat.error === undefined ? {} : { error: { ...stat.error } }),
    ...(stat.workspaceBefore === undefined ? {} : { workspaceBefore: { ...stat.workspaceBefore } }),
    ...(stat.workspaceAfter === undefined ? {} : { workspaceAfter: { ...stat.workspaceAfter } }),
  };
}

function compactHeader(details: CompactToolResultDetails): string {
  const fields = [
    `resultId=${details.resultId}`,
    `state=${details.state}`,
    `complete=${details.complete}`,
    `chunks=${details.chunkCount}`,
    `bytes=${details.totalBytes}`,
    `lines=${details.totalLines}`,
  ];
  if (details.exitCode !== undefined) fields.push(`exitCode=${details.exitCode}`);
  if (details.sha256 !== undefined) fields.push(`sha256=${details.sha256}`);
  if (details.workspaceBefore !== undefined) {
    fields.push(
      `workspaceBefore=${boundedMessage(details.workspaceBefore.layerId, 512)}@${details.workspaceBefore.durableSeq}`,
    );
  }
  if (details.workspaceAfter !== undefined) {
    fields.push(`workspaceAfter=${boundedMessage(details.workspaceAfter.layerId, 512)}@${details.workspaceAfter.durableSeq}`);
  }
  if (details.error !== undefined) {
    fields.push(`error=${boundedMessage(details.error.code, 256)}:${boundedMessage(details.error.message, 1024)}`);
  }
  return `Drive9 durable result\n${fields.join("\n")}`;
}

async function compactResult(
  store: ToolResultStore,
  stat: ResultStat,
  previewBytes: number,
): Promise<AgentToolResult<CompactToolResultDetails>> {
  const details = statDetails(stat);
  const header = compactHeader(details);
  const headerBytes = Buffer.byteLength(`${header}\npreview:\n`, "utf8");
  const availablePreview = Math.max(0, previewBytes - headerBytes);
  let preview = "";
  if (stat.totalBytes > 0 && availablePreview > 0) {
    const page = await store.readRange(stat.resultId, {
      offset: 0,
      length: Math.min(availablePreview, MAX_PREVIEW_BYTES),
      ...(stat.state === "unknown" ? { allowIncomplete: true } : {}),
    });
    preview = utf8Prefix(page.bytes, availablePreview);
  }
  const text = preview.length === 0 ? header : `${header}\npreview:\n${preview}`;
  if (Buffer.byteLength(text, "utf8") > previewBytes) {
    throw new ResultStoreError("limit_exceeded", "compact result exceeds the preview limit");
  }
  return { content: [{ type: "text", text }], details };
}

export function createAfterToolCallFallback(
  options: AfterToolCallFallbackOptions,
): (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined> {
  const thresholdBytes = configuredInteger(
    options.thresholdBytes,
    FALLBACK_THRESHOLD_BYTES,
    1,
    MAX_MODEL_RESULT_BYTES,
    "thresholdBytes",
  );
  const previewBytes = configuredInteger(
    options.previewBytes,
    DEFAULT_PREVIEW_BYTES,
    1,
    MAX_PREVIEW_BYTES,
    "previewBytes",
  );
  return async (context, _signal) => {
    if (!context.result.content.every((part) => part.type === "text")) return undefined;
    const text = context.result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    if (Buffer.byteLength(text, "utf8") <= thresholdBytes) return undefined;
    const identity = await allocateIdentity(options.allocateIdentity, {
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
    });
    const begun = await options.store.begin({
      identity,
      toolName: context.toolCall.name,
      mediaType: MEDIA_TYPE,
    });
    if (begun.kind === "terminal") {
      const compact = await compactResult(options.store, begun.stat, previewBytes);
      return { content: compact.content, details: compact.details };
    }
    const chunks = splitUtf8(text);
    for (let seq = 0; seq < chunks.length; seq += 1) {
      const data = chunks[seq];
      if (data === undefined) throw new ResultStoreError("corrupt", "fallback chunk is missing");
      await begun.writer.append({ seq, stream: "tool", data });
    }
    let workspaceAfter: WorkspaceRevision | undefined;
    let captureError: { code: string; message: string } | undefined;
    if (options.workspaceRevisionProvider !== undefined) {
      try {
        workspaceAfter = await options.workspaceRevisionProvider.capture();
      } catch (error) {
        captureError = { code: "workspace_capture_failed", message: boundedMessage(errorValue(error).message) };
      }
    }
    const terminal = await begun.writer.finalize({
      state: context.isError ? "failed" : "completed",
      chunkCount: chunks.length,
      ...(captureError === undefined ? {} : { error: captureError }),
      ...(workspaceAfter === undefined ? {} : { workspaceAfter }),
    });
    const compact = await compactResult(options.store, terminal, previewBytes);
    return { content: compact.content, details: compact.details };
  };
}

function requireSessionScope(stat: ResultStat, currentSessionId: string): void {
  if (typeof currentSessionId !== "string" || currentSessionId.length === 0) {
    throw new ResultStoreError("invalid", "current session id is unavailable");
  }
  if (stat.identity.sessionId !== currentSessionId) {
    throw new ResultStoreError("permission_denied", "result does not belong to the current session");
  }
}

function encodeReadCursor(resultId: string, startLine: number): string {
  return Buffer.from(JSON.stringify({ v: 1, kind: "result_read", resultId, startLine }), "utf8").toString("base64url");
}

function decodeReadCursor(value: string, resultId: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const record = parsed as Record<string, unknown>;
    if (
      record.v !== 1 ||
      record.kind !== "result_read" ||
      record.resultId !== resultId ||
      !Number.isSafeInteger(record.startLine) ||
      (record.startLine as number) < 0
    ) {
      throw new Error("cursor mismatch");
    }
    return record.startLine as number;
  } catch (error) {
    throw new ResultStoreError("invalid", "result_read cursor is invalid", errorValue(error));
  }
}

function readPageText(page: Awaited<ReturnType<ToolResultStore["readLines"]>>, cursor?: string): string {
  const metadata = JSON.stringify({
    resultId: page.resultId,
    state: page.state,
    complete: page.complete,
    startByte: page.startByte,
    endByte: page.endByte,
    startLine: page.startLine,
    endLine: page.endLine,
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
    ...(page.workspaceBefore === undefined ? {} : { workspaceBefore: page.workspaceBefore }),
    ...(page.workspaceAfter === undefined ? {} : { workspaceAfter: page.workspaceAfter }),
  });
  return `${metadata}\n--- text ---\n${page.text}`;
}

export function createResultReadTool(options: ResultToolOptions): AgentTool<typeof resultReadParameters, unknown> {
  return {
    name: "result_read",
    label: "Result Read",
    description: "Read a bounded line page from a durable Drive9 tool result in the current session.",
    parameters: resultReadParameters,
    execute: async (_toolCallId, params) => {
      if (params.cursor !== undefined && params.startLine !== undefined) {
        throw new ResultStoreError("invalid", "provide cursor or startLine, not both");
      }
      const stat = await options.store.stat(params.resultId);
      requireSessionScope(stat, options.currentSessionId());
      const startLine =
        params.cursor === undefined ? (params.startLine ?? 0) : decodeReadCursor(params.cursor, params.resultId);
      const page = await options.store.readLines(params.resultId, {
        startLine,
        maxLines: params.maxLines ?? 200,
        maxBytes: params.maxBytes ?? MAX_RESULT_READ_TEXT_BYTES,
        ...(params.allowIncomplete === undefined ? {} : { allowIncomplete: params.allowIncomplete }),
      });
      const nextCursor = page.nextCursor === undefined ? undefined : encodeReadCursor(params.resultId, page.endLine);
      const text = readPageText(page, nextCursor);
      if (Buffer.byteLength(text, "utf8") > MAX_MODEL_RESULT_BYTES) {
        throw new ResultStoreError("limit_exceeded", "result_read response exceeds the model-visible limit");
      }
      return { content: [{ type: "text", text }], details: { ...page, nextCursor } };
    },
  };
}

function searchPageText(page: Awaited<ReturnType<ToolResultStore["search"]>>): string {
  const metadata = JSON.stringify({
    resultId: page.resultId,
    state: page.state,
    complete: page.complete,
    scannedBytes: page.scannedBytes,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    ...(page.workspaceBefore === undefined ? {} : { workspaceBefore: page.workspaceBefore }),
    ...(page.workspaceAfter === undefined ? {} : { workspaceAfter: page.workspaceAfter }),
  });
  const matches = page.matches
    .map((match) => `match byte=${match.byteOffset} line=${match.line}\n${match.text}`)
    .join("\n---\n");
  return matches.length === 0 ? metadata : `${metadata}\n--- matches ---\n${matches}`;
}

export function createResultSearchTool(options: ResultToolOptions): AgentTool<typeof resultSearchParameters, unknown> {
  return {
    name: "result_search",
    label: "Result Search",
    description: "Search a bounded portion of a durable Drive9 tool result in the current session.",
    parameters: resultSearchParameters,
    execute: async (_toolCallId, params) => {
      const stat = await options.store.stat(params.resultId);
      requireSessionScope(stat, options.currentSessionId());
      let maxMatches = params.maxMatches ?? 20;
      for (;;) {
        const page = await options.store.search(params.resultId, {
          query: params.query,
          maxMatches,
          ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
          ...(params.caseSensitive === undefined ? {} : { caseSensitive: params.caseSensitive }),
          ...(params.contextBytes === undefined ? {} : { contextBytes: params.contextBytes }),
          ...(params.allowIncomplete === undefined ? {} : { allowIncomplete: params.allowIncomplete }),
        });
        const text = searchPageText(page);
        if (Buffer.byteLength(text, "utf8") <= MAX_MODEL_RESULT_BYTES) {
          return { content: [{ type: "text", text }], details: page };
        }
        if (maxMatches === 1) {
          throw new ResultStoreError("limit_exceeded", "result_search response exceeds the model-visible limit");
        }
        maxMatches = Math.max(1, Math.floor(maxMatches / 2));
      }
    },
  };
}
