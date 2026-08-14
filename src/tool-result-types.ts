export type ResultState = "writing" | "completed" | "failed" | "aborted" | "unknown";

export interface ToolResultIdentity {
  sessionId: string;
  runId: string;
  toolCallId: string;
  attempt: number;
}

export interface BeginResultInput {
  identity: ToolResultIdentity;
  toolName: string;
  mediaType: "text/plain; charset=utf-8";
}

export interface AppendInput {
  seq: number;
  stream: "stdout" | "stderr" | "tool";
  data: Uint8Array;
}

export interface FinalizeInput {
  state: Exclude<ResultState, "writing">;
  chunkCount: number;
  exitCode?: number;
  error?: { code: string; message: string };
}

export interface ResultStat {
  resultId: string;
  identity: ToolResultIdentity;
  toolName: string;
  mediaType: "text/plain; charset=utf-8";
  state: ResultState;
  complete: boolean;
  chunkCount: number;
  totalBytes: number;
  totalLines: number;
  sha256?: string;
  exitCode?: number;
  error?: { code: string; message: string };
  manifestRevision: number;
}

export interface ResultWriter {
  readonly resultId: string;
  readonly nextSeq: number;
  append(input: AppendInput): Promise<void>;
  finalize(input: FinalizeInput): Promise<ResultStat>;
}

export type BeginResult =
  | {
      kind: "writing";
      disposition: "created" | "existing";
      writer: ResultWriter;
      stat: ResultStat;
    }
  | { kind: "terminal"; stat: ResultStat };

export interface ReadLinesInput {
  startLine: number;
  maxLines: number;
  maxBytes?: number;
  allowIncomplete?: boolean;
}

export interface ReadRangeInput {
  offset: number;
  length: number;
  allowIncomplete?: boolean;
}

export interface ReadPage {
  resultId: string;
  state: Exclude<ResultState, "writing">;
  complete: boolean;
  text: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  nextCursor?: string;
}

export interface BytePage {
  resultId: string;
  state: Exclude<ResultState, "writing">;
  complete: boolean;
  bytes: Uint8Array;
  startByte: number;
  endByte: number;
  nextOffset?: number;
}

export interface SearchInput {
  query: string;
  caseSensitive?: boolean;
  cursor?: string;
  maxMatches?: number;
  contextBytes?: number;
  allowIncomplete?: boolean;
}

export interface SearchMatch {
  byteOffset: number;
  line: number;
  text: string;
}

export interface SearchPage {
  resultId: string;
  state: Exclude<ResultState, "writing">;
  complete: boolean;
  matches: SearchMatch[];
  scannedBytes: number;
  nextCursor?: string;
}

export interface RecoverInput {
  identity: ToolResultIdentity;
  action: "mark_unknown";
  reason: string;
}

export interface ToolResultStore {
  begin(input: BeginResultInput): Promise<BeginResult>;
  stat(resultId: string): Promise<ResultStat>;
  readLines(resultId: string, input: ReadLinesInput): Promise<ReadPage>;
  readRange(resultId: string, input: ReadRangeInput): Promise<BytePage>;
  search(resultId: string, input: SearchInput): Promise<SearchPage>;
  recover(resultId: string, input: RecoverInput): Promise<ResultStat>;
}

export type ResultStoreErrorCode =
  | "invalid"
  | "not_found"
  | "permission_denied"
  | "conflict"
  | "limit_exceeded"
  | "incomplete"
  | "corrupt"
  | "unavailable"
  | "aborted";

export class ResultStoreError extends Error {
  readonly code: ResultStoreErrorCode;

  constructor(code: ResultStoreErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResultStoreError";
    this.code = code;
  }
}

export interface ResultStoreObject {
  data: Uint8Array;
  revision: number;
}

export interface ResultStoreBackend {
  create(path: string, data: Uint8Array): Promise<{ revision: number }>;
  read(path: string): Promise<ResultStoreObject>;
  replace(path: string, data: Uint8Array, expectedRevision: number): Promise<{ revision: number }>;
}

export interface PersistentToolResultStoreOptions {
  backend: ResultStoreBackend;
  pathPrefix?: string;
  maxChunkBytes?: number;
  maxChunks?: number;
  maxResultBytes?: number;
  maxReadBytes?: number;
  maxReadLines?: number;
  maxSearchMatches?: number;
  maxSearchScanBytes?: number;
  maxSearchQueryBytes?: number;
  maxModelResponseBytes?: number;
}
