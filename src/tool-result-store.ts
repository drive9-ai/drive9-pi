import { createHash } from "node:crypto";
import { posix } from "node:path";
import { deriveResultId } from "./result-id.js";
import {
  type AppendInput,
  type BeginResult,
  type BeginResultInput,
  type BytePage,
  type FinalizeInput,
  type PersistentToolResultStoreOptions,
  type ReadLinesInput,
  type ReadPage,
  type ReadRangeInput,
  type RecoverInput,
  type ResultState,
  ResultStoreError,
  type ResultStoreObject,
  type ResultStat,
  type ResultWriter,
  type SearchInput,
  type SearchMatch,
  type SearchPage,
  type ToolResultIdentity,
  type ToolResultStore,
} from "./tool-result-types.js";

const HARD_MAX_CHUNK_BYTES = 64 * 1024;
const HARD_MAX_CHUNKS = 16_384;
const HARD_MAX_RESULT_BYTES = 1024 * 1024 * 1024;
const HARD_MAX_READ_BYTES = 64 * 1024;
const HARD_MAX_READ_LINES = 1_000;
const HARD_MAX_SEARCH_MATCHES = 100;
const HARD_MAX_SEARCH_SCAN_BYTES = 64 * 1024 * 1024;
const HARD_MAX_SEARCH_QUERY_BYTES = 64 * 1024;
const HARD_MAX_MODEL_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_SEARCH_MATCHES = 20;
const DEFAULT_CONTEXT_BYTES = 160;
const MEDIA_TYPE = "text/plain; charset=utf-8" as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const RESULT_ID_PATTERN = /^r1_[0-9a-f]{64}$/;

interface StoreLimits {
  maxChunkBytes: number;
  maxChunks: number;
  maxResultBytes: number;
  maxReadBytes: number;
  maxReadLines: number;
  maxSearchMatches: number;
  maxSearchScanBytes: number;
  maxSearchQueryBytes: number;
  maxModelResponseBytes: number;
}

interface ManifestBase {
  schemaVersion: 1;
  resultId: string;
  identity: ToolResultIdentity;
  toolName: string;
  mediaType: typeof MEDIA_TYPE;
}

interface WritingManifest extends ManifestBase {
  state: "writing";
  committedChunkCount: number;
  committedTotalBytes: number;
}

interface StreamCount {
  chunks: number;
  bytes: number;
  newlines: number;
}

interface ChunkIndexEntry {
  seq: number;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
}

interface NormalizedFinalizeInput {
  state: Exclude<ResultState, "writing">;
  chunkCount: number;
  exitCode?: number;
  error?: { code: string; message: string };
}

interface TerminalAggregate {
  chunkCount: number;
  totalBytes: number;
  totalLines: number;
  sha256: string;
  streamCounts: Record<AppendInput["stream"], StreamCount>;
  index: ChunkIndexEntry[];
}

interface TerminalData extends TerminalAggregate {
  finalizeInput: NormalizedFinalizeInput;
}

interface TerminalManifest extends ManifestBase {
  state: Exclude<ResultState, "writing">;
  terminal: TerminalData;
}

type StoredManifest = WritingManifest | TerminalManifest;

interface ChunkEnvelope {
  schemaVersion: 1;
  resultId: string;
  seq: number;
  stream: AppendInput["stream"];
  payloadLength: number;
  payloadSha256: string;
  payloadBase64: string;
}

interface ParsedManifest {
  manifest: StoredManifest;
  revision: number;
}

interface SearchHit {
  byteOffset: number;
  endByte: number;
  line: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

function normalizeBackendError(error: unknown): ResultStoreError {
  if (error instanceof ResultStoreError) return error;
  const cause = toError(error);
  return new ResultStoreError("unavailable", cause.message, cause);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ResultStoreError("corrupt", `${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ResultStoreError("corrupt", `${label} must be a string`);
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new ResultStoreError("corrupt", `${label} must be a safe integer`);
  return value as number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const parsed = requireInteger(value, label);
  if (parsed < 0) throw new ResultStoreError("corrupt", `${label} must be non-negative`);
  return parsed;
}

function requirePositiveRevision(value: unknown, label: string): number {
  const parsed = requireInteger(value, label);
  if (parsed <= 0) throw new ResultStoreError("corrupt", `${label} must be positive`);
  return parsed;
}

function requireSha256(value: unknown, label: string): string {
  const parsed = requireString(value, label);
  if (!/^[0-9a-f]{64}$/.test(parsed)) throw new ResultStoreError("corrupt", `${label} is not SHA-256`);
  return parsed;
}

function inputRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ResultStoreError("invalid", `${label} must be an object`);
  return value;
}

function inputString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ResultStoreError("invalid", `${label} must be a string`);
  return value;
}

function inputNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ResultStoreError("invalid", `${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function cloneIdentity(identity: ToolResultIdentity): ToolResultIdentity {
  return {
    sessionId: identity.sessionId,
    runId: identity.runId,
    toolCallId: identity.toolCallId,
    attempt: identity.attempt,
  };
}

function normalizeIdentity(value: unknown): ToolResultIdentity {
  const record = inputRecord(value, "identity");
  const identity = {
    sessionId: inputString(record.sessionId, "identity.sessionId"),
    runId: inputString(record.runId, "identity.runId"),
    toolCallId: inputString(record.toolCallId, "identity.toolCallId"),
    attempt: inputNonNegativeInteger(record.attempt, "identity.attempt"),
  };
  deriveResultId(identity);
  return identity;
}

function parseIdentity(value: unknown): ToolResultIdentity {
  try {
    return normalizeIdentity(value);
  } catch (error) {
    throw new ResultStoreError("corrupt", "manifest identity is invalid", toError(error));
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new ResultStoreError("invalid", "value is not JSON-serializable");
  return encoded;
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function parseJson(data: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(UTF8_DECODER.decode(data));
  } catch (error) {
    const cause = toError(error);
    throw new ResultStoreError("corrupt", `${label} is not valid UTF-8 JSON`, cause);
  }
}

function configuredLimit(value: number | undefined, hardMaximum: number, label: string): number {
  const selected = value ?? hardMaximum;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > hardMaximum) {
    throw new ResultStoreError("invalid", `${label} must be an integer between 1 and ${hardMaximum}`);
  }
  return selected;
}

function normalizePathPrefix(value: string | undefined): string {
  const selected = value ?? "v1/results";
  if (
    selected.length === 0 ||
    selected.includes("\0") ||
    selected.includes("\\") ||
    posix.isAbsolute(selected) ||
    posix.normalize(selected) !== selected ||
    selected === "." ||
    selected.startsWith("../")
  ) {
    throw new ResultStoreError("invalid", "pathPrefix must be a normalized relative path");
  }
  return selected.endsWith("/") ? selected.slice(0, -1) : selected;
}

function normalizeBeginInput(input: BeginResultInput): BeginResultInput {
  const record = inputRecord(input, "begin input");
  const identity = normalizeIdentity(record.identity);
  const toolName = inputString(record.toolName, "toolName");
  if (toolName.length === 0 || hasUnpairedSurrogate(toolName)) {
    throw new ResultStoreError("invalid", "toolName must be non-empty");
  }
  if (record.mediaType !== MEDIA_TYPE) throw new ResultStoreError("invalid", `mediaType must be ${MEDIA_TYPE}`);
  return { identity, toolName, mediaType: MEDIA_TYPE };
}

function normalizeFinalizeInput(input: FinalizeInput, maxChunks: number): NormalizedFinalizeInput {
  const record = inputRecord(input, "finalize input");
  const state = record.state as FinalizeInput["state"];
  if (!(["completed", "failed", "aborted", "unknown"] as const).includes(state)) {
    throw new ResultStoreError("invalid", "finalize state is invalid");
  }
  if (!Number.isSafeInteger(record.chunkCount) || (record.chunkCount as number) < 0) {
    throw new ResultStoreError("invalid", "chunkCount must be a non-negative safe integer");
  }
  if ((record.chunkCount as number) > maxChunks) {
    throw new ResultStoreError("limit_exceeded", `chunkCount must be between 0 and ${maxChunks}`);
  }
  const chunkCount = record.chunkCount as number;
  if (record.exitCode !== undefined && !Number.isSafeInteger(record.exitCode)) {
    throw new ResultStoreError("invalid", "exitCode must be a safe integer");
  }
  const exitCode = record.exitCode as number | undefined;
  const error = record.error;
  if (
    error !== undefined &&
    (!isRecord(error) ||
      typeof error.code !== "string" ||
      error.code.length === 0 ||
      hasUnpairedSurrogate(error.code) ||
      typeof error.message !== "string" ||
      hasUnpairedSurrogate(error.message))
  ) {
    throw new ResultStoreError("invalid", "error must contain a non-empty code and a message");
  }
  return {
    state,
    chunkCount,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(error === undefined ? {} : { error: { code: error.code as string, message: error.message as string } }),
  };
}

function normalizeResultId(resultId: string): string {
  if (typeof resultId !== "string" || !RESULT_ID_PATTERN.test(resultId)) {
    throw new ResultStoreError("invalid", "resultId is invalid");
  }
  return resultId;
}

function normalizeReadInteger(value: number, label: string, minimum: number, maximum?: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ResultStoreError("invalid", `${label} must be a safe integer of at least ${minimum}`);
  }
  if (maximum !== undefined && value > maximum) {
    throw new ResultStoreError("limit_exceeded", `${label} exceeds ${maximum}`);
  }
  return value;
}

function parseFinalizeInput(value: unknown): NormalizedFinalizeInput {
  const record = requireRecord(value, "terminal.finalizeInput");
  const state = requireString(record.state, "terminal.finalizeInput.state") as FinalizeInput["state"];
  const chunkCount = requireNonNegativeInteger(record.chunkCount, "terminal.finalizeInput.chunkCount");
  const exitCode = record.exitCode === undefined ? undefined : requireInteger(record.exitCode, "terminal.finalizeInput.exitCode");
  let error: { code: string; message: string } | undefined;
  if (record.error !== undefined) {
    const errorRecord = requireRecord(record.error, "terminal.finalizeInput.error");
    error = {
      code: requireString(errorRecord.code, "terminal.finalizeInput.error.code"),
      message: requireString(errorRecord.message, "terminal.finalizeInput.error.message"),
    };
  }
  try {
    return normalizeFinalizeInput(
      {
        state,
        chunkCount,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(error === undefined ? {} : { error }),
      },
      HARD_MAX_CHUNKS,
    );
  } catch (error) {
    throw new ResultStoreError("corrupt", "terminal.finalizeInput is invalid", toError(error));
  }
}

function parseStreamCount(value: unknown, label: string): StreamCount {
  const record = requireRecord(value, label);
  return {
    chunks: requireNonNegativeInteger(record.chunks, `${label}.chunks`),
    bytes: requireNonNegativeInteger(record.bytes, `${label}.bytes`),
    newlines: requireNonNegativeInteger(record.newlines, `${label}.newlines`),
  };
}

function parseIndex(value: unknown, chunkCount: number, totalBytes: number): ChunkIndexEntry[] {
  if (!Array.isArray(value) || value.length !== chunkCount) {
    throw new ResultStoreError("corrupt", "terminal.index length does not match chunkCount");
  }
  const entries = value.map((item, index) => {
    const record = requireRecord(item, `terminal.index[${index}]`);
    return {
      seq: requireNonNegativeInteger(record.seq, `terminal.index[${index}].seq`),
      startByte: requireNonNegativeInteger(record.startByte, `terminal.index[${index}].startByte`),
      endByte: requireNonNegativeInteger(record.endByte, `terminal.index[${index}].endByte`),
      startLine: requireNonNegativeInteger(record.startLine, `terminal.index[${index}].startLine`),
      endLine: requireNonNegativeInteger(record.endLine, `terminal.index[${index}].endLine`),
    };
  });
  let nextByte = 0;
  let nextLine = 0;
  for (const [position, entry] of entries.entries()) {
    if (
      entry.seq !== position ||
      entry.startByte !== nextByte ||
      entry.endByte < entry.startByte ||
      entry.startLine !== nextLine ||
      entry.endLine < entry.startLine
    ) {
      throw new ResultStoreError("corrupt", "terminal.index is not contiguous");
    }
    nextByte = entry.endByte;
    nextLine = entry.endLine;
  }
  if (nextByte !== totalBytes) throw new ResultStoreError("corrupt", "terminal.index byte total is invalid");
  return entries;
}

function parseManifestObject(object: ResultStoreObject, expectedResultId: string): ParsedManifest {
  const revision = requirePositiveRevision(object.revision, "manifest revision");
  const record = requireRecord(parseJson(object.data, "manifest"), "manifest");
  if (record.schemaVersion !== 1) throw new ResultStoreError("corrupt", "manifest schemaVersion is unsupported");
  const resultId = requireString(record.resultId, "manifest.resultId");
  if (resultId !== expectedResultId) throw new ResultStoreError("corrupt", "manifest resultId does not match its path");
  const identity = parseIdentity(record.identity);
  if (deriveResultId(identity) !== resultId) throw new ResultStoreError("corrupt", "manifest identity does not match resultId");
  const toolName = requireString(record.toolName, "manifest.toolName");
  const mediaType = requireString(record.mediaType, "manifest.mediaType");
  if (toolName.length === 0 || mediaType !== MEDIA_TYPE) throw new ResultStoreError("corrupt", "manifest metadata is invalid");
  const state = requireString(record.state, "manifest.state") as ResultState;
  const base = {
    schemaVersion: 1 as const,
    resultId,
    identity,
    toolName,
    mediaType: MEDIA_TYPE,
  };
  if (state === "writing") {
    return {
      manifest: {
        ...base,
        state,
        committedChunkCount: requireNonNegativeInteger(
          record.committedChunkCount,
          "manifest.committedChunkCount",
        ),
        committedTotalBytes: requireNonNegativeInteger(
          record.committedTotalBytes,
          "manifest.committedTotalBytes",
        ),
      },
      revision,
    };
  }
  if (!(["completed", "failed", "aborted", "unknown"] as const).includes(state)) {
    throw new ResultStoreError("corrupt", "manifest state is invalid");
  }
  const terminalRecord = requireRecord(record.terminal, "manifest.terminal");
  const chunkCount = requireNonNegativeInteger(terminalRecord.chunkCount, "terminal.chunkCount");
  const totalBytes = requireNonNegativeInteger(terminalRecord.totalBytes, "terminal.totalBytes");
  const totalLines = requireNonNegativeInteger(terminalRecord.totalLines, "terminal.totalLines");
  const sha256 = requireSha256(terminalRecord.sha256, "terminal.sha256");
  const streamCountsRecord = requireRecord(terminalRecord.streamCounts, "terminal.streamCounts");
  const finalizeInput = parseFinalizeInput(terminalRecord.finalizeInput);
  if (finalizeInput.state !== state || finalizeInput.chunkCount !== chunkCount) {
    throw new ResultStoreError("corrupt", "terminal finalize input does not match manifest state");
  }
  const terminal = {
    finalizeInput,
    chunkCount,
    totalBytes,
    totalLines,
    sha256,
    streamCounts: {
      stdout: parseStreamCount(streamCountsRecord.stdout, "terminal.streamCounts.stdout"),
      stderr: parseStreamCount(streamCountsRecord.stderr, "terminal.streamCounts.stderr"),
      tool: parseStreamCount(streamCountsRecord.tool, "terminal.streamCounts.tool"),
    },
    index: parseIndex(terminalRecord.index, chunkCount, totalBytes),
  };
  const countedChunks = Object.values(terminal.streamCounts).reduce((total, count) => total + count.chunks, 0);
  const countedBytes = Object.values(terminal.streamCounts).reduce((total, count) => total + count.bytes, 0);
  const countedNewlines = Object.values(terminal.streamCounts).reduce((total, count) => total + count.newlines, 0);
  const indexedNewlines = terminal.index.at(-1)?.endLine ?? 0;
  if (
    countedChunks !== chunkCount ||
    countedBytes !== totalBytes ||
    countedNewlines !== indexedNewlines ||
    (totalBytes === 0
      ? totalLines !== 0 || countedNewlines !== 0
      : totalLines !== countedNewlines && totalLines !== countedNewlines + 1)
  ) {
    throw new ResultStoreError("corrupt", "terminal aggregate counts are inconsistent");
  }
  return { manifest: { ...base, state, terminal }, revision };
}

function parseChunkObject(object: ResultStoreObject, resultId: string, expectedSeq: number): ChunkEnvelope {
  requirePositiveRevision(object.revision, `chunk ${expectedSeq} revision`);
  const record = requireRecord(parseJson(object.data, `chunk ${expectedSeq}`), `chunk ${expectedSeq}`);
  if (record.schemaVersion !== 1) throw new ResultStoreError("corrupt", `chunk ${expectedSeq} schema is unsupported`);
  const envelope: ChunkEnvelope = {
    schemaVersion: 1,
    resultId: requireString(record.resultId, `chunk ${expectedSeq}.resultId`),
    seq: requireNonNegativeInteger(record.seq, `chunk ${expectedSeq}.seq`),
    stream: requireString(record.stream, `chunk ${expectedSeq}.stream`) as AppendInput["stream"],
    payloadLength: requireNonNegativeInteger(record.payloadLength, `chunk ${expectedSeq}.payloadLength`),
    payloadSha256: requireSha256(record.payloadSha256, `chunk ${expectedSeq}.payloadSha256`),
    payloadBase64: requireString(record.payloadBase64, `chunk ${expectedSeq}.payloadBase64`),
  };
  if (
    envelope.resultId !== resultId ||
    envelope.seq !== expectedSeq ||
    !(["stdout", "stderr", "tool"] as const).includes(envelope.stream)
  ) {
    throw new ResultStoreError("corrupt", `chunk ${expectedSeq} envelope does not match its path`);
  }
  const payload = Buffer.from(envelope.payloadBase64, "base64");
  if (
    payload.toString("base64") !== envelope.payloadBase64 ||
    payload.length !== envelope.payloadLength ||
    createHash("sha256").update(payload).digest("hex") !== envelope.payloadSha256
  ) {
    throw new ResultStoreError("corrupt", `chunk ${expectedSeq} payload is corrupt`);
  }
  try {
    UTF8_DECODER.decode(payload);
  } catch (error) {
    throw new ResultStoreError("corrupt", `chunk ${expectedSeq} payload is not UTF-8`, toError(error));
  }
  return envelope;
}

function chunkPayload(envelope: ChunkEnvelope): Buffer {
  return Buffer.from(envelope.payloadBase64, "base64");
}

function chunksMatch(left: ChunkEnvelope, right: ChunkEnvelope): boolean {
  return (
    left.seq === right.seq &&
    left.stream === right.stream &&
    left.payloadLength === right.payloadLength &&
    left.payloadSha256 === right.payloadSha256
  );
}

function emptyStreamCount(): StreamCount {
  return { chunks: 0, bytes: 0, newlines: 0 };
}

function countNewlines(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count;
}

function makeWritingManifest(resultId: string, input: BeginResultInput): WritingManifest {
  return {
    schemaVersion: 1,
    resultId,
    identity: cloneIdentity(input.identity),
    toolName: input.toolName,
    mediaType: MEDIA_TYPE,
    state: "writing",
    committedChunkCount: 0,
    committedTotalBytes: 0,
  };
}

function manifestsMatchBegin(manifest: StoredManifest, input: BeginResultInput): boolean {
  return (
    canonicalJson(manifest.identity) === canonicalJson(input.identity) &&
    manifest.toolName === input.toolName &&
    manifest.mediaType === input.mediaType
  );
}

function completeForState(state: ResultState): boolean {
  return state !== "writing" && state !== "unknown";
}

function statFromTerminal(manifest: TerminalManifest, revision: number): ResultStat {
  const finalize = manifest.terminal.finalizeInput;
  return {
    resultId: manifest.resultId,
    identity: cloneIdentity(manifest.identity),
    toolName: manifest.toolName,
    mediaType: MEDIA_TYPE,
    state: manifest.state,
    complete: completeForState(manifest.state),
    chunkCount: manifest.terminal.chunkCount,
    totalBytes: manifest.terminal.totalBytes,
    totalLines: manifest.terminal.totalLines,
    sha256: manifest.terminal.sha256,
    ...(finalize.exitCode === undefined ? {} : { exitCode: finalize.exitCode }),
    ...(finalize.error === undefined
      ? {}
      : { error: { code: finalize.error.code, message: finalize.error.message } }),
    manifestRevision: revision,
  };
}

function terminalManifest(
  writing: WritingManifest,
  input: NormalizedFinalizeInput,
  aggregate: TerminalAggregate,
): TerminalManifest {
  return {
    schemaVersion: 1,
    resultId: writing.resultId,
    identity: cloneIdentity(writing.identity),
    toolName: writing.toolName,
    mediaType: MEDIA_TYPE,
    state: input.state,
    terminal: {
      finalizeInput: input,
      chunkCount: aggregate.chunkCount,
      totalBytes: aggregate.totalBytes,
      totalLines: aggregate.totalLines,
      sha256: aggregate.sha256,
      streamCounts: aggregate.streamCounts,
      index: aggregate.index,
    },
  };
}

function terminalMatches(
  manifest: TerminalManifest,
  input: NormalizedFinalizeInput,
  aggregate: TerminalAggregate,
): boolean {
  return (
    canonicalJson(manifest.terminal.finalizeInput) === canonicalJson(input) &&
    manifest.terminal.chunkCount === aggregate.chunkCount &&
    manifest.terminal.totalBytes === aggregate.totalBytes &&
    manifest.terminal.totalLines === aggregate.totalLines &&
    manifest.terminal.sha256 === aggregate.sha256 &&
    canonicalJson(manifest.terminal.streamCounts) === canonicalJson(aggregate.streamCounts) &&
    canonicalJson(manifest.terminal.index) === canonicalJson(aggregate.index)
  );
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");
}

function decodeCursor(value: string, resultId: string, kind: string): Record<string, unknown> {
  try {
    const parsed = requireRecord(JSON.parse(Buffer.from(value, "base64url").toString("utf8")), "cursor");
    if (parsed.v !== 1 || parsed.kind !== kind || parsed.resultId !== resultId) {
      throw new ResultStoreError("invalid", "cursor does not match this result or operation");
    }
    return parsed;
  } catch (error) {
    if (error instanceof ResultStoreError) throw error;
    throw new ResultStoreError("invalid", "cursor is invalid", toError(error));
  }
}

function foldCodePoint(value: string, caseSensitive: boolean): string[] {
  return Array.from(caseSensitive ? value : value.toLowerCase());
}

function buildPrefixTable(pattern: string[]): number[] {
  const prefix = new Array<number>(pattern.length).fill(0);
  let matched = 0;
  for (let index = 1; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = prefix[matched - 1] ?? 0;
    if (pattern[index] === pattern[matched]) matched += 1;
    prefix[index] = matched;
  }
  return prefix;
}

function searchCursorQuery(query: string, caseSensitive: boolean): string {
  return createHash("sha256").update(caseSensitive ? "1\0" : "0\0").update(query, "utf8").digest("hex");
}

class PersistentResultWriter implements ResultWriter {
  readonly resultId: string;
  private committedChunkCount: number;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: PersistentToolResultStore,
    resultId: string,
    committedChunkCount: number,
  ) {
    this.resultId = resultId;
    this.committedChunkCount = committedChunkCount;
  }

  get nextSeq(): number {
    return this.committedChunkCount;
  }

  async append(input: AppendInput): Promise<void> {
    await this.enqueue(async () => {
      this.committedChunkCount = await this.store.appendChunk(this.resultId, input);
    });
  }

  async finalize(input: FinalizeInput): Promise<ResultStat> {
    return await this.enqueue(async () => await this.store.finalizeResult(this.resultId, input));
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.operationTail.then(operation, operation);
    this.operationTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return await queued;
  }
}

export class PersistentToolResultStore implements ToolResultStore {
  private readonly backend: PersistentToolResultStoreOptions["backend"];
  private readonly pathPrefix: string;
  private readonly limits: StoreLimits;
  private readonly resultMutationTails = new Map<string, Promise<void>>();

  constructor(options: PersistentToolResultStoreOptions) {
    if (!options || !options.backend) throw new ResultStoreError("invalid", "backend is required");
    for (const method of ["create", "read", "replace"] as const) {
      if (typeof options.backend[method] !== "function") {
        throw new ResultStoreError("invalid", `backend.${method} must be a function`);
      }
    }
    this.backend = options.backend;
    this.pathPrefix = normalizePathPrefix(options.pathPrefix);
    this.limits = {
      maxChunkBytes: configuredLimit(options.maxChunkBytes, HARD_MAX_CHUNK_BYTES, "maxChunkBytes"),
      maxChunks: configuredLimit(options.maxChunks, HARD_MAX_CHUNKS, "maxChunks"),
      maxResultBytes: configuredLimit(options.maxResultBytes, HARD_MAX_RESULT_BYTES, "maxResultBytes"),
      maxReadBytes: configuredLimit(options.maxReadBytes, HARD_MAX_READ_BYTES, "maxReadBytes"),
      maxReadLines: configuredLimit(options.maxReadLines, HARD_MAX_READ_LINES, "maxReadLines"),
      maxSearchMatches: configuredLimit(
        options.maxSearchMatches,
        HARD_MAX_SEARCH_MATCHES,
        "maxSearchMatches",
      ),
      maxSearchScanBytes: configuredLimit(
        options.maxSearchScanBytes,
        HARD_MAX_SEARCH_SCAN_BYTES,
        "maxSearchScanBytes",
      ),
      maxSearchQueryBytes: configuredLimit(
        options.maxSearchQueryBytes,
        HARD_MAX_SEARCH_QUERY_BYTES,
        "maxSearchQueryBytes",
      ),
      maxModelResponseBytes: configuredLimit(
        options.maxModelResponseBytes,
        HARD_MAX_MODEL_RESPONSE_BYTES,
        "maxModelResponseBytes",
      ),
    };
  }

  async begin(input: BeginResultInput): Promise<BeginResult> {
    const normalized = normalizeBeginInput(input);
    const resultId = deriveResultId(normalized.identity);
    const manifest = makeWritingManifest(resultId, normalized);
    try {
      const created = await this.backendCall(async () => await this.backend.create(this.manifestPath(resultId), jsonBytes(manifest)));
      const revision = requirePositiveRevision(created.revision, "manifest revision");
      return {
        kind: "writing",
        disposition: "created",
        writer: new PersistentResultWriter(this, resultId, 0),
        stat: this.writingStat(manifest, revision, this.emptyAggregate()),
      };
    } catch (error) {
      const normalizedError = normalizeBackendError(error);
      if (normalizedError.code !== "conflict") throw normalizedError;
    }
    const existing = await this.readManifest(resultId);
    if (!manifestsMatchBegin(existing.manifest, normalized)) {
      throw new ResultStoreError("conflict", "result identity metadata conflicts with the existing manifest");
    }
    if (existing.manifest.state !== "writing") {
      return { kind: "terminal", stat: statFromTerminal(existing.manifest, existing.revision) };
    }
    const aggregate = await this.aggregateWritingManifest(existing.manifest);
    return {
      kind: "writing",
      disposition: "existing",
      writer: new PersistentResultWriter(this, resultId, existing.manifest.committedChunkCount),
      stat: this.writingStat(existing.manifest, existing.revision, aggregate),
    };
  }

  async stat(resultId: string): Promise<ResultStat> {
    const normalized = normalizeResultId(resultId);
    const parsed = await this.readManifest(normalized);
    if (parsed.manifest.state !== "writing") return statFromTerminal(parsed.manifest, parsed.revision);
    return this.writingStat(
      parsed.manifest,
      parsed.revision,
      await this.aggregateWritingManifest(parsed.manifest),
    );
  }

  async readLines(resultId: string, input: ReadLinesInput): Promise<ReadPage> {
    const normalized = normalizeResultId(resultId);
    const record = inputRecord(input, "readLines input");
    const startLine = normalizeReadInteger(record.startLine as number, "startLine", 0);
    const maxLines = normalizeReadInteger(record.maxLines as number, "maxLines", 1, this.limits.maxReadLines);
    const maxBytes = normalizeReadInteger(
      (record.maxBytes as number | undefined) ?? this.limits.maxReadBytes,
      "maxBytes",
      1,
      this.limits.maxReadBytes,
    );
    if (record.allowIncomplete !== undefined && typeof record.allowIncomplete !== "boolean") {
      throw new ResultStoreError("invalid", "allowIncomplete must be boolean");
    }
    const parsed = await this.terminalForRead(normalized, record.allowIncomplete === true);
    const manifest = parsed.manifest;
    if (startLine >= manifest.terminal.totalLines) {
      return this.readPage(manifest, "", manifest.terminal.totalBytes, manifest.terminal.totalBytes, startLine, startLine);
    }
    const firstIndex = manifest.terminal.index.findIndex((entry) => entry.endLine >= startLine);
    if (firstIndex < 0) throw new ResultStoreError("corrupt", "line index does not contain startLine");
    let currentLine = manifest.terminal.index[firstIndex]?.startLine ?? 0;
    let currentByte = manifest.terminal.index[firstIndex]?.startByte ?? 0;
    let lineStartByte = currentByte;
    let pageStartByte: number | undefined;
    let pageEndByte = currentByte;
    let outputBytes = 0;
    const parts: string[] = [];
    const lineParts: string[] = [];
    let lineBytes = 0;
    let completedLines = 0;
    let stopped = false;
    for (let indexPosition = firstIndex; indexPosition < manifest.terminal.index.length && !stopped; indexPosition += 1) {
      const entry = manifest.terminal.index[indexPosition];
      if (!entry) throw new ResultStoreError("corrupt", "line index entry is missing");
      const payload = await this.readVerifiedChunk(normalized, entry.seq);
      for (const codePoint of UTF8_DECODER.decode(payload)) {
        const codePointBytes = Buffer.byteLength(codePoint, "utf8");
        if (currentLine < startLine) {
          currentByte += codePointBytes;
          if (codePoint === "\n") {
            currentLine += 1;
            lineStartByte = currentByte;
          }
          continue;
        }
        pageStartByte ??= lineStartByte;
        if (outputBytes + lineBytes + codePointBytes > maxBytes) {
          if (completedLines === 0) {
            throw new ResultStoreError("limit_exceeded", "maxBytes cannot contain the next complete line");
          }
          stopped = true;
          break;
        }
        lineParts.push(codePoint);
        lineBytes += codePointBytes;
        currentByte += codePointBytes;
        if (codePoint === "\n") {
          parts.push(...lineParts);
          outputBytes += lineBytes;
          lineParts.length = 0;
          lineBytes = 0;
          currentLine += 1;
          completedLines += 1;
          pageEndByte = currentByte;
          lineStartByte = currentByte;
          if (completedLines >= maxLines) {
            stopped = true;
            break;
          }
        }
      }
    }
    if (!stopped && lineParts.length > 0) {
      parts.push(...lineParts);
      outputBytes += lineBytes;
      completedLines += 1;
      pageEndByte = currentByte;
    }
    const text = parts.join("");
    const endLine = startLine + completedLines;
    return this.readPage(
      manifest,
      text,
      pageStartByte ?? manifest.terminal.totalBytes,
      pageEndByte,
      startLine,
      endLine,
      pageEndByte < manifest.terminal.totalBytes
        ? encodeCursor({ kind: "lines", resultId: normalized, startLine: endLine, offset: pageEndByte })
        : undefined,
    );
  }

  async readRange(resultId: string, input: ReadRangeInput): Promise<BytePage> {
    const normalized = normalizeResultId(resultId);
    const record = inputRecord(input, "readRange input");
    const offset = normalizeReadInteger(record.offset as number, "offset", 0);
    const length = normalizeReadInteger(record.length as number, "length", 1, this.limits.maxReadBytes);
    if (record.allowIncomplete !== undefined && typeof record.allowIncomplete !== "boolean") {
      throw new ResultStoreError("invalid", "allowIncomplete must be boolean");
    }
    const parsed = await this.terminalForRead(normalized, record.allowIncomplete === true);
    const manifest = parsed.manifest;
    const startByte = Math.min(offset, manifest.terminal.totalBytes);
    const endByte = Math.min(startByte + length, manifest.terminal.totalBytes);
    const bytes = await this.readPayloadRange(manifest, startByte, endByte);
    return {
      resultId: normalized,
      state: manifest.state,
      complete: completeForState(manifest.state),
      bytes,
      startByte,
      endByte,
      ...(endByte < manifest.terminal.totalBytes ? { nextOffset: endByte } : {}),
    };
  }

  async search(resultId: string, input: SearchInput): Promise<SearchPage> {
    const normalized = normalizeResultId(resultId);
    const record = inputRecord(input, "search input");
    if (typeof record.query !== "string" || record.query.length === 0 || hasUnpairedSurrogate(record.query)) {
      throw new ResultStoreError("invalid", "query must be non-empty");
    }
    const query = record.query;
    const queryBytes = Buffer.byteLength(query, "utf8");
    if (queryBytes > this.limits.maxSearchQueryBytes) {
      throw new ResultStoreError("limit_exceeded", "query exceeds maxSearchQueryBytes");
    }
    try {
      UTF8_DECODER.decode(Buffer.from(query, "utf8"));
    } catch (error) {
      throw new ResultStoreError("invalid", "query must be valid UTF-8", toError(error));
    }
    const maxMatches = normalizeReadInteger(
      (record.maxMatches as number | undefined) ?? Math.min(DEFAULT_SEARCH_MATCHES, this.limits.maxSearchMatches),
      "maxMatches",
      1,
      this.limits.maxSearchMatches,
    );
    const contextBytes = normalizeReadInteger(
      (record.contextBytes as number | undefined) ?? Math.min(DEFAULT_CONTEXT_BYTES, this.limits.maxModelResponseBytes),
      "contextBytes",
      0,
      this.limits.maxModelResponseBytes,
    );
    if (record.caseSensitive !== undefined && typeof record.caseSensitive !== "boolean") {
      throw new ResultStoreError("invalid", "caseSensitive must be boolean");
    }
    if (record.allowIncomplete !== undefined && typeof record.allowIncomplete !== "boolean") {
      throw new ResultStoreError("invalid", "allowIncomplete must be boolean");
    }
    const caseSensitive = (record.caseSensitive as boolean | undefined) ?? true;
    const queryKey = searchCursorQuery(query, caseSensitive);
    const parsed = await this.terminalForRead(normalized, record.allowIncomplete === true);
    const manifest = parsed.manifest;
    const cursor =
      record.cursor === undefined ? undefined : decodeCursor(inputString(record.cursor, "cursor"), normalized, "search");
    if (cursor !== undefined && cursor.query !== queryKey) {
      throw new ResultStoreError("invalid", "cursor does not match this search query");
    }
    const scanStart =
      cursor === undefined ? 0 : normalizeReadInteger(cursor.offset as number, "cursor.offset", 0, manifest.terminal.totalBytes);
    if (scanStart >= manifest.terminal.totalBytes) {
      return this.searchPage(manifest, [], 0);
    }
    const desiredEnd = Math.min(scanStart + this.limits.maxSearchScanBytes, manifest.terminal.totalBytes);
    const primaryEnd = await this.utf8BoundaryAtOrBefore(manifest, scanStart, desiredEnd);
    if (primaryEnd <= scanStart) {
      throw new ResultStoreError("limit_exceeded", "maxSearchScanBytes cannot contain the next UTF-8 code point");
    }
    const pattern = Array.from(query).flatMap((codePoint) => foldCodePoint(codePoint, caseSensitive));
    if (pattern.length === 0) throw new ResultStoreError("invalid", "query folds to an empty pattern");
    const lookaheadEnd = Math.min(primaryEnd + pattern.length * 4, manifest.terminal.totalBytes);
    const alignedLookaheadEnd = await this.utf8BoundaryAtOrBefore(manifest, primaryEnd, lookaheadEnd);
    const scanBytes = await this.readPayloadRange(manifest, scanStart, alignedLookaheadEnd);
    const scanText = UTF8_DECODER.decode(scanBytes);
    const prefix = buildPrefixTable(pattern);
    const ringStarts = new Array<number>(pattern.length).fill(0);
    const ringEnds = new Array<number>(pattern.length).fill(0);
    const ringLines = new Array<number>(pattern.length).fill(0);
    let patternState = 0;
    let foldedIndex = 0;
    let sourceByte = scanStart;
    let sourceLine = await this.lineAtByte(manifest, scanStart);
    let nextCursorOffset: number | undefined;
    const hits: SearchHit[] = [];
    let previousHit = -1;
    outer: for (const sourceCodePoint of scanText) {
      const sourceWidth = Buffer.byteLength(sourceCodePoint, "utf8");
      const sourceStart = sourceByte;
      const sourceEnd = sourceStart + sourceWidth;
      for (const foldedCodePoint of foldCodePoint(sourceCodePoint, caseSensitive)) {
        const ringPosition = foldedIndex % pattern.length;
        ringStarts[ringPosition] = sourceStart;
        ringEnds[ringPosition] = sourceEnd;
        ringLines[ringPosition] = sourceLine;
        while (patternState > 0 && foldedCodePoint !== pattern[patternState]) {
          patternState = prefix[patternState - 1] ?? 0;
        }
        if (foldedCodePoint === pattern[patternState]) patternState += 1;
        if (patternState === pattern.length) {
          const startPosition = (foldedIndex - pattern.length + 1) % pattern.length;
          const normalizedPosition = startPosition < 0 ? startPosition + pattern.length : startPosition;
          const byteOffset = ringStarts[normalizedPosition] ?? 0;
          if (byteOffset >= scanStart && byteOffset < primaryEnd && byteOffset !== previousHit) {
            hits.push({ byteOffset, endByte: sourceEnd, line: ringLines[normalizedPosition] ?? sourceLine });
            previousHit = byteOffset;
            if (hits.length >= maxMatches) {
              nextCursorOffset = ringEnds[normalizedPosition];
              sourceByte = sourceEnd;
              break outer;
            }
          }
          patternState = prefix[patternState - 1] ?? 0;
        }
        foldedIndex += 1;
      }
      sourceByte = sourceEnd;
      if (sourceCodePoint === "\n") sourceLine += 1;
      if (sourceByte >= alignedLookaheadEnd) break;
    }
    if (nextCursorOffset === undefined && primaryEnd < manifest.terminal.totalBytes) nextCursorOffset = primaryEnd;
    let responseBudget = this.limits.maxModelResponseBytes;
    const matches: SearchMatch[] = [];
    for (const hit of hits) {
      const requestedContext = Math.min(contextBytes, responseBudget);
      const text =
        requestedContext === 0
          ? ""
          : await this.readContext(manifest, hit.byteOffset, hit.endByte, requestedContext);
      responseBudget -= Buffer.byteLength(text, "utf8");
      matches.push({ byteOffset: hit.byteOffset, line: hit.line, text });
    }
    const scannedBytes = Math.max(0, Math.min(sourceByte, primaryEnd) - scanStart);
    return this.searchPage(
      manifest,
      matches,
      scannedBytes,
      nextCursorOffset === undefined
        ? undefined
        : encodeCursor({ kind: "search", resultId: normalized, query: queryKey, offset: nextCursorOffset }),
    );
  }

  async recover(resultId: string, input: RecoverInput): Promise<ResultStat> {
    const normalized = normalizeResultId(resultId);
    return await this.serializeResultMutation(normalized, async () => await this.recoverUnlocked(normalized, input));
  }

  private async recoverUnlocked(normalized: string, input: RecoverInput): Promise<ResultStat> {
    const record = inputRecord(input, "recover input");
    if (
      record.action !== "mark_unknown" ||
      typeof record.reason !== "string" ||
      record.reason.length === 0 ||
      hasUnpairedSurrogate(record.reason)
    ) {
      throw new ResultStoreError("invalid", "recover requires mark_unknown and a non-empty reason");
    }
    const identity = normalizeIdentity(record.identity);
    if (deriveResultId(identity) !== normalized) {
      throw new ResultStoreError("permission_denied", "recover identity does not match resultId");
    }
    const current = await this.readManifest(normalized);
    if (canonicalJson(current.manifest.identity) !== canonicalJson(identity)) {
      throw new ResultStoreError("permission_denied", "recover identity does not match manifest identity");
    }
    const recoveryError = { code: "recovered_unknown", message: record.reason };
    if (current.manifest.state !== "writing") {
      const finalize = current.manifest.terminal.finalizeInput;
      if (
        current.manifest.state === "unknown" &&
        finalize.error?.code === recoveryError.code &&
        finalize.error.message === recoveryError.message
      ) {
        return statFromTerminal(current.manifest, current.revision);
      }
      throw new ResultStoreError("conflict", "only a writing result can be recovered");
    }
    return await this.finalizeResultUnlocked(normalized, {
      state: "unknown",
      chunkCount: current.manifest.committedChunkCount,
      error: recoveryError,
    });
  }

  async appendChunk(resultId: string, input: AppendInput): Promise<number> {
    const normalized = normalizeResultId(resultId);
    return await this.serializeResultMutation(
      normalized,
      async () => await this.appendChunkUnlocked(normalized, input),
    );
  }

  private async appendChunkUnlocked(normalized: string, input: AppendInput): Promise<number> {
    const record = inputRecord(input, "append input");
    if (!Number.isSafeInteger(record.seq) || (record.seq as number) < 0) {
      throw new ResultStoreError("invalid", "seq must be a non-negative safe integer");
    }
    if ((record.seq as number) >= this.limits.maxChunks) {
      throw new ResultStoreError("limit_exceeded", `seq must be between 0 and ${this.limits.maxChunks - 1}`);
    }
    const seq = record.seq as number;
    const stream = record.stream as AppendInput["stream"];
    if (!(["stdout", "stderr", "tool"] as const).includes(stream)) {
      throw new ResultStoreError("invalid", "stream is invalid");
    }
    if (!(record.data instanceof Uint8Array)) throw new ResultStoreError("invalid", "data must be Uint8Array");
    const payload = Buffer.from(record.data);
    if (payload.length > this.limits.maxChunkBytes) {
      throw new ResultStoreError("limit_exceeded", `chunk exceeds ${this.limits.maxChunkBytes} bytes`);
    }
    try {
      UTF8_DECODER.decode(payload);
    } catch (error) {
      throw new ResultStoreError("invalid", "chunk data must be independently valid UTF-8", toError(error));
    }
    const envelope: ChunkEnvelope = {
      schemaVersion: 1,
      resultId: normalized,
      seq,
      stream,
      payloadLength: payload.length,
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
      payloadBase64: payload.toString("base64"),
    };
    const current = await this.readManifest(normalized);
    if (current.manifest.state !== "writing") {
      if (seq >= current.manifest.terminal.chunkCount) {
        throw new ResultStoreError("conflict", "terminal results cannot accept new chunks");
      }
      await this.requireMatchingChunk(normalized, envelope);
      return current.manifest.terminal.chunkCount;
    }
    if (seq > current.manifest.committedChunkCount) {
      throw new ResultStoreError(
        "conflict",
        `chunk ${seq} creates a gap after committed chunk ${current.manifest.committedChunkCount - 1}`,
      );
    }
    if (seq < current.manifest.committedChunkCount) {
      await this.requireMatchingChunk(normalized, envelope);
      return current.manifest.committedChunkCount;
    }
    if (current.manifest.committedTotalBytes + payload.length > this.limits.maxResultBytes) {
      throw new ResultStoreError("limit_exceeded", "result exceeds maxResultBytes");
    }
    try {
      await this.backendCall(async () => await this.backend.create(this.chunkPath(normalized, seq), jsonBytes(envelope)));
    } catch (error) {
      const normalizedError = normalizeBackendError(error);
      if (normalizedError.code !== "conflict") throw normalizedError;
      await this.requireMatchingChunk(normalized, envelope);
    }

    const committed: WritingManifest = {
      ...current.manifest,
      committedChunkCount: current.manifest.committedChunkCount + 1,
      committedTotalBytes: current.manifest.committedTotalBytes + payload.length,
    };
    try {
      const replaced = await this.backendCall(
        async () =>
          await this.backend.replace(
            this.manifestPath(normalized),
            jsonBytes(committed),
            current.revision,
          ),
      );
      requirePositiveRevision(replaced.revision, "manifest revision");
      return committed.committedChunkCount;
    } catch (error) {
      const normalizedError = normalizeBackendError(error);
      if (normalizedError.code !== "conflict" && normalizedError.code !== "unavailable") {
        throw normalizedError;
      }
      const winner = await this.readManifest(normalized);
      if (winner.manifest.state !== "writing") {
        if (seq < winner.manifest.terminal.chunkCount) {
          await this.requireMatchingChunk(normalized, envelope);
          return winner.manifest.terminal.chunkCount;
        }
        throw new ResultStoreError("conflict", "finalize won before the chunk was committed");
      }
      if (winner.manifest.committedChunkCount > seq) {
        await this.requireMatchingChunk(normalized, envelope);
        return winner.manifest.committedChunkCount;
      }
      if (winner.manifest.committedChunkCount < seq) {
        throw new ResultStoreError("corrupt", "committed chunk count moved backwards");
      }
      throw normalizedError;
    }
  }

  async finalizeResult(resultId: string, input: FinalizeInput): Promise<ResultStat> {
    const normalized = normalizeResultId(resultId);
    return await this.serializeResultMutation(normalized, async () => await this.finalizeResultUnlocked(normalized, input));
  }

  private async finalizeResultUnlocked(normalized: string, input: FinalizeInput): Promise<ResultStat> {
    const normalizedInput = normalizeFinalizeInput(input, this.limits.maxChunks);
    const current = await this.readManifest(normalized);
    if (current.manifest.state !== "writing") {
      if (normalizedInput.chunkCount !== current.manifest.terminal.chunkCount) {
        throw new ResultStoreError("conflict", "terminal result does not match finalize input");
      }
      const aggregate = await this.aggregateChunks(normalized, current.manifest.terminal.chunkCount);
      if (terminalMatches(current.manifest, normalizedInput, aggregate)) {
        return statFromTerminal(current.manifest, current.revision);
      }
      throw new ResultStoreError("conflict", "terminal result does not match finalize input");
    }
    if (normalizedInput.chunkCount !== current.manifest.committedChunkCount) {
      throw new ResultStoreError(
        "conflict",
        `finalize expected ${normalizedInput.chunkCount} chunks, manifest committed ${current.manifest.committedChunkCount}`,
      );
    }
    const aggregate = await this.aggregateWritingManifest(current.manifest);
    const terminal = terminalManifest(current.manifest, normalizedInput, aggregate);
    try {
      const replaced = await this.backendCall(
        async () => await this.backend.replace(this.manifestPath(normalized), jsonBytes(terminal), current.revision),
      );
      return statFromTerminal(terminal, requirePositiveRevision(replaced.revision, "manifest revision"));
    } catch (error) {
      const normalizedError = normalizeBackendError(error);
      if (normalizedError.code !== "conflict" && normalizedError.code !== "unavailable") {
        throw normalizedError;
      }
      const winner = await this.readManifest(normalized);
      if (winner.manifest.state !== "writing" && terminalMatches(winner.manifest, normalizedInput, aggregate)) {
        return statFromTerminal(winner.manifest, winner.revision);
      }
      if (winner.manifest.state === "writing" && normalizedError.code === "unavailable") {
        throw normalizedError;
      }
      throw new ResultStoreError("conflict", "concurrent mutation produced a different result state");
    }
  }

  private async backendCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw normalizeBackendError(error);
    }
  }

  private async serializeResultMutation<T>(resultId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.resultMutationTails.get(resultId) ?? Promise.resolve();
    const running = previous.then(operation, operation);
    const tail = running.then(
      () => undefined,
      () => undefined,
    );
    this.resultMutationTails.set(resultId, tail);
    try {
      return await running;
    } finally {
      if (this.resultMutationTails.get(resultId) === tail) this.resultMutationTails.delete(resultId);
    }
  }

  private resultDirectory(resultId: string): string {
    const digest = resultId.slice(3);
    return `${this.pathPrefix}/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${resultId}`;
  }

  private manifestPath(resultId: string): string {
    return `${this.resultDirectory(resultId)}/manifest.json`;
  }

  private chunksPrefix(resultId: string): string {
    return `${this.resultDirectory(resultId)}/chunks/`;
  }

  private chunkPath(resultId: string, sequence: number): string {
    return `${this.chunksPrefix(resultId)}${sequence.toString().padStart(12, "0")}.json`;
  }

  private async readManifest(resultId: string): Promise<ParsedManifest> {
    const object = await this.backendCall(async () => await this.backend.read(this.manifestPath(resultId)));
    const parsed = parseManifestObject(object, resultId);
    const chunkCount =
      parsed.manifest.state === "writing"
        ? parsed.manifest.committedChunkCount
        : parsed.manifest.terminal.chunkCount;
    const totalBytes =
      parsed.manifest.state === "writing"
        ? parsed.manifest.committedTotalBytes
        : parsed.manifest.terminal.totalBytes;
    if (chunkCount > this.limits.maxChunks || totalBytes > this.limits.maxResultBytes) {
      throw new ResultStoreError("limit_exceeded", "stored result exceeds configured limits");
    }
    return parsed;
  }

  private async readVerifiedChunk(resultId: string, sequence: number): Promise<Buffer> {
    const envelope = await this.readChunkEnvelope(resultId, sequence);
    if (envelope.payloadLength > this.limits.maxChunkBytes) {
      throw new ResultStoreError("limit_exceeded", `chunk ${sequence} exceeds maxChunkBytes`);
    }
    return chunkPayload(envelope);
  }

  private async requireMatchingChunk(resultId: string, expected: ChunkEnvelope): Promise<void> {
    const existing = await this.readChunkEnvelope(resultId, expected.seq);
    if (!chunksMatch(existing, expected)) {
      throw new ResultStoreError("conflict", `chunk ${expected.seq} already exists with different content`);
    }
  }

  private async readChunkEnvelope(resultId: string, sequence: number): Promise<ChunkEnvelope> {
    let object: ResultStoreObject;
    try {
      object = await this.backendCall(async () => await this.backend.read(this.chunkPath(resultId, sequence)));
    } catch (error) {
      const normalized = normalizeBackendError(error);
      if (normalized.code === "not_found") {
        throw new ResultStoreError("incomplete", `chunk ${sequence} is missing`, normalized);
      }
      throw normalized;
    }
    return parseChunkObject(object, resultId, sequence);
  }

  private emptyAggregate(): TerminalAggregate {
    return {
      chunkCount: 0,
      totalBytes: 0,
      totalLines: 0,
      sha256: createHash("sha256").digest("hex"),
      streamCounts: { stdout: emptyStreamCount(), stderr: emptyStreamCount(), tool: emptyStreamCount() },
      index: [],
    };
  }

  private async aggregateChunks(resultId: string, chunkCount: number): Promise<TerminalAggregate> {
    const aggregateHash = createHash("sha256");
    const streamCounts = { stdout: emptyStreamCount(), stderr: emptyStreamCount(), tool: emptyStreamCount() };
    const index: ChunkIndexEntry[] = [];
    let totalBytes = 0;
    let totalNewlines = 0;
    let finalByte: number | undefined;
    for (let sequence = 0; sequence < chunkCount; sequence += 1) {
      const envelope = await this.readChunkEnvelope(resultId, sequence);
      if (envelope.payloadLength > this.limits.maxChunkBytes) {
        throw new ResultStoreError("limit_exceeded", `chunk ${sequence} exceeds maxChunkBytes`);
      }
      const payload = chunkPayload(envelope);
      if (totalBytes + payload.length > this.limits.maxResultBytes) {
        throw new ResultStoreError("limit_exceeded", "result exceeds maxResultBytes");
      }
      const newlines = countNewlines(payload);
      const startByte = totalBytes;
      const startLine = totalNewlines;
      totalBytes += payload.length;
      totalNewlines += newlines;
      aggregateHash.update(payload);
      const counts = streamCounts[envelope.stream];
      counts.chunks += 1;
      counts.bytes += payload.length;
      counts.newlines += newlines;
      index.push({ seq: sequence, startByte, endByte: totalBytes, startLine, endLine: totalNewlines });
      if (payload.length > 0) finalByte = payload[payload.length - 1];
    }
    const totalLines = totalBytes === 0 ? 0 : totalNewlines + (finalByte === 0x0a ? 0 : 1);
    return {
      chunkCount,
      totalBytes,
      totalLines,
      sha256: aggregateHash.digest("hex"),
      streamCounts,
      index,
    };
  }

  private async aggregateWritingManifest(manifest: WritingManifest): Promise<TerminalAggregate> {
    const aggregate = await this.aggregateChunks(manifest.resultId, manifest.committedChunkCount);
    if (aggregate.totalBytes !== manifest.committedTotalBytes) {
      throw new ResultStoreError("corrupt", "writing manifest committed byte total is inconsistent");
    }
    return aggregate;
  }

  private writingStat(manifest: WritingManifest, revision: number, aggregate: TerminalAggregate): ResultStat {
    return {
      resultId: manifest.resultId,
      identity: cloneIdentity(manifest.identity),
      toolName: manifest.toolName,
      mediaType: MEDIA_TYPE,
      state: "writing",
      complete: false,
      chunkCount: aggregate.chunkCount,
      totalBytes: aggregate.totalBytes,
      totalLines: aggregate.totalLines,
      manifestRevision: revision,
    };
  }

  private async terminalForRead(resultId: string, allowIncomplete: boolean): Promise<{ manifest: TerminalManifest }> {
    const parsed = await this.readManifest(resultId);
    if (parsed.manifest.state === "writing") {
      throw new ResultStoreError("incomplete", "writing results cannot be read");
    }
    if (parsed.manifest.state === "unknown" && !allowIncomplete) {
      throw new ResultStoreError("incomplete", "unknown results require allowIncomplete");
    }
    return { manifest: parsed.manifest };
  }

  private async readPayloadRange(manifest: TerminalManifest, startByte: number, endByte: number): Promise<Uint8Array> {
    if (startByte < 0 || endByte < startByte || endByte > manifest.terminal.totalBytes) {
      throw new ResultStoreError("invalid", "payload range is invalid");
    }
    if (startByte === endByte) return new Uint8Array();
    const parts: Buffer[] = [];
    let collected = 0;
    for (const entry of manifest.terminal.index) {
      if (entry.endByte <= startByte) continue;
      if (entry.startByte >= endByte) break;
      const payload = await this.readVerifiedChunk(manifest.resultId, entry.seq);
      if (payload.length !== entry.endByte - entry.startByte) {
        throw new ResultStoreError("corrupt", `chunk ${entry.seq} length does not match terminal index`);
      }
      const localStart = Math.max(0, startByte - entry.startByte);
      const localEnd = Math.min(payload.length, endByte - entry.startByte);
      const slice = payload.subarray(localStart, localEnd);
      parts.push(slice);
      collected += slice.length;
    }
    if (collected !== endByte - startByte) throw new ResultStoreError("corrupt", "payload range is incomplete");
    return Buffer.concat(parts, collected);
  }

  private readPage(
    manifest: TerminalManifest,
    text: string,
    startByte: number,
    endByte: number,
    startLine: number,
    endLine: number,
    nextCursor?: string,
  ): ReadPage {
    return {
      resultId: manifest.resultId,
      state: manifest.state,
      complete: completeForState(manifest.state),
      text,
      startByte,
      endByte,
      startLine,
      endLine,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  private searchPage(
    manifest: TerminalManifest,
    matches: SearchMatch[],
    scannedBytes: number,
    nextCursor?: string,
  ): SearchPage {
    return {
      resultId: manifest.resultId,
      state: manifest.state,
      complete: completeForState(manifest.state),
      matches,
      scannedBytes,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  private async utf8BoundaryAtOrBefore(
    manifest: TerminalManifest,
    minimum: number,
    desired: number,
  ): Promise<number> {
    if (desired >= manifest.terminal.totalBytes) return manifest.terminal.totalBytes;
    let boundary = desired;
    while (boundary > minimum) {
      const next = await this.readPayloadRange(manifest, boundary, boundary + 1);
      const byte = next[0];
      if (byte === undefined || (byte & 0xc0) !== 0x80) return boundary;
      boundary -= 1;
    }
    return boundary;
  }

  private async lineAtByte(manifest: TerminalManifest, offset: number): Promise<number> {
    if (offset <= 0) return 0;
    if (offset >= manifest.terminal.totalBytes) return manifest.terminal.totalLines;
    const entry = manifest.terminal.index.find((candidate) => candidate.endByte > offset);
    if (!entry) throw new ResultStoreError("corrupt", "line index does not contain byte offset");
    const prefix = await this.readPayloadRange(manifest, entry.startByte, offset);
    return entry.startLine + countNewlines(prefix);
  }

  private async readContext(
    manifest: TerminalManifest,
    byteOffset: number,
    matchEndByte: number,
    maximumBytes: number,
  ): Promise<string> {
    if (maximumBytes <= 0) return "";
    const matchBytes = Math.max(0, matchEndByte - byteOffset);
    const before = Math.floor(Math.max(0, maximumBytes - Math.min(matchBytes, maximumBytes)) / 2);
    let start = Math.max(0, byteOffset - before);
    let end = Math.min(manifest.terminal.totalBytes, start + maximumBytes);
    if (end - start < maximumBytes) start = Math.max(0, end - maximumBytes);
    const bytes = Buffer.from(await this.readPayloadRange(manifest, start, end));
    let localStart = 0;
    while (localStart < bytes.length && (bytes[localStart]! & 0xc0) === 0x80) localStart += 1;
    let localEnd = bytes.length;
    while (localEnd > localStart) {
      try {
        return UTF8_DECODER.decode(bytes.subarray(localStart, localEnd));
      } catch {
        localEnd -= 1;
      }
    }
    return "";
  }
}
