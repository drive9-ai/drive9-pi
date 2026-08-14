import { createHash } from "node:crypto";
import { posix } from "node:path";
import { deriveResultId } from "./result-id.js";
import { ResultStoreError, } from "./tool-result-types.js";
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
const MEDIA_TYPE = "text/plain; charset=utf-8";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const RESULT_ID_PATTERN = /^r1_[0-9a-f]{64}$/;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toError(value) {
    if (value instanceof Error)
        return value;
    if (typeof value === "string")
        return new Error(value);
    try {
        return new Error(JSON.stringify(value));
    }
    catch {
        return new Error(String(value));
    }
}
function normalizeBackendError(error) {
    if (error instanceof ResultStoreError)
        return error;
    const cause = toError(error);
    return new ResultStoreError("unavailable", cause.message, cause);
}
function requireRecord(value, label) {
    if (!isRecord(value))
        throw new ResultStoreError("corrupt", `${label} must be an object`);
    return value;
}
function requireString(value, label) {
    if (typeof value !== "string")
        throw new ResultStoreError("corrupt", `${label} must be a string`);
    return value;
}
function requireInteger(value, label) {
    if (!Number.isSafeInteger(value))
        throw new ResultStoreError("corrupt", `${label} must be a safe integer`);
    return value;
}
function requireNonNegativeInteger(value, label) {
    const parsed = requireInteger(value, label);
    if (parsed < 0)
        throw new ResultStoreError("corrupt", `${label} must be non-negative`);
    return parsed;
}
function requirePositiveRevision(value, label) {
    const parsed = requireInteger(value, label);
    if (parsed <= 0)
        throw new ResultStoreError("corrupt", `${label} must be positive`);
    return parsed;
}
function requireSha256(value, label) {
    const parsed = requireString(value, label);
    if (!/^[0-9a-f]{64}$/.test(parsed))
        throw new ResultStoreError("corrupt", `${label} is not SHA-256`);
    return parsed;
}
function inputRecord(value, label) {
    if (!isRecord(value))
        throw new ResultStoreError("invalid", `${label} must be an object`);
    return value;
}
function inputString(value, label) {
    if (typeof value !== "string")
        throw new ResultStoreError("invalid", `${label} must be a string`);
    return value;
}
function inputNonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new ResultStoreError("invalid", `${label} must be a non-negative safe integer`);
    }
    return value;
}
function hasUnpairedSurrogate(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            if (index + 1 >= value.length)
                return true;
            const next = value.charCodeAt(index + 1);
            if (next < 0xdc00 || next > 0xdfff)
                return true;
            index += 1;
        }
        else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
}
function cloneIdentity(identity) {
    return {
        sessionId: identity.sessionId,
        runId: identity.runId,
        toolCallId: identity.toolCallId,
        attempt: identity.attempt,
    };
}
function normalizeIdentity(value) {
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
function parseIdentity(value) {
    try {
        return normalizeIdentity(value);
    }
    catch (error) {
        throw new ResultStoreError("corrupt", "manifest identity is invalid", toError(error));
    }
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(",")}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
        throw new ResultStoreError("invalid", "value is not JSON-serializable");
    return encoded;
}
function jsonBytes(value) {
    return Buffer.from(JSON.stringify(value), "utf8");
}
function parseJson(data, label) {
    try {
        return JSON.parse(UTF8_DECODER.decode(data));
    }
    catch (error) {
        const cause = toError(error);
        throw new ResultStoreError("corrupt", `${label} is not valid UTF-8 JSON`, cause);
    }
}
function configuredLimit(value, hardMaximum, label) {
    const selected = value ?? hardMaximum;
    if (!Number.isSafeInteger(selected) || selected <= 0 || selected > hardMaximum) {
        throw new ResultStoreError("invalid", `${label} must be an integer between 1 and ${hardMaximum}`);
    }
    return selected;
}
function normalizePathPrefix(value) {
    const selected = value ?? "v1/results";
    if (selected.length === 0 ||
        selected.includes("\0") ||
        selected.includes("\\") ||
        posix.isAbsolute(selected) ||
        posix.normalize(selected) !== selected ||
        selected === "." ||
        selected.startsWith("../")) {
        throw new ResultStoreError("invalid", "pathPrefix must be a normalized relative path");
    }
    return selected.endsWith("/") ? selected.slice(0, -1) : selected;
}
function normalizeBeginInput(input) {
    const record = inputRecord(input, "begin input");
    const identity = normalizeIdentity(record.identity);
    const toolName = inputString(record.toolName, "toolName");
    if (toolName.length === 0 || hasUnpairedSurrogate(toolName)) {
        throw new ResultStoreError("invalid", "toolName must be non-empty");
    }
    if (record.mediaType !== MEDIA_TYPE)
        throw new ResultStoreError("invalid", `mediaType must be ${MEDIA_TYPE}`);
    return { identity, toolName, mediaType: MEDIA_TYPE };
}
function normalizeFinalizeInput(input, maxChunks) {
    const record = inputRecord(input, "finalize input");
    const state = record.state;
    if (!["completed", "failed", "aborted", "unknown"].includes(state)) {
        throw new ResultStoreError("invalid", "finalize state is invalid");
    }
    if (!Number.isSafeInteger(record.chunkCount) || record.chunkCount < 0) {
        throw new ResultStoreError("invalid", "chunkCount must be a non-negative safe integer");
    }
    if (record.chunkCount > maxChunks) {
        throw new ResultStoreError("limit_exceeded", `chunkCount must be between 0 and ${maxChunks}`);
    }
    const chunkCount = record.chunkCount;
    if (record.exitCode !== undefined && !Number.isSafeInteger(record.exitCode)) {
        throw new ResultStoreError("invalid", "exitCode must be a safe integer");
    }
    const exitCode = record.exitCode;
    const error = record.error;
    if (error !== undefined &&
        (!isRecord(error) ||
            typeof error.code !== "string" ||
            error.code.length === 0 ||
            hasUnpairedSurrogate(error.code) ||
            typeof error.message !== "string" ||
            hasUnpairedSurrogate(error.message))) {
        throw new ResultStoreError("invalid", "error must contain a non-empty code and a message");
    }
    return {
        state,
        chunkCount,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(error === undefined ? {} : { error: { code: error.code, message: error.message } }),
    };
}
function normalizeResultId(resultId) {
    if (typeof resultId !== "string" || !RESULT_ID_PATTERN.test(resultId)) {
        throw new ResultStoreError("invalid", "resultId is invalid");
    }
    return resultId;
}
function normalizeReadInteger(value, label, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new ResultStoreError("invalid", `${label} must be a safe integer of at least ${minimum}`);
    }
    if (maximum !== undefined && value > maximum) {
        throw new ResultStoreError("limit_exceeded", `${label} exceeds ${maximum}`);
    }
    return value;
}
function parseFinalizeInput(value) {
    const record = requireRecord(value, "terminal.finalizeInput");
    const state = requireString(record.state, "terminal.finalizeInput.state");
    const chunkCount = requireNonNegativeInteger(record.chunkCount, "terminal.finalizeInput.chunkCount");
    const exitCode = record.exitCode === undefined ? undefined : requireInteger(record.exitCode, "terminal.finalizeInput.exitCode");
    let error;
    if (record.error !== undefined) {
        const errorRecord = requireRecord(record.error, "terminal.finalizeInput.error");
        error = {
            code: requireString(errorRecord.code, "terminal.finalizeInput.error.code"),
            message: requireString(errorRecord.message, "terminal.finalizeInput.error.message"),
        };
    }
    try {
        return normalizeFinalizeInput({
            state,
            chunkCount,
            ...(exitCode === undefined ? {} : { exitCode }),
            ...(error === undefined ? {} : { error }),
        }, HARD_MAX_CHUNKS);
    }
    catch (error) {
        throw new ResultStoreError("corrupt", "terminal.finalizeInput is invalid", toError(error));
    }
}
function parseStreamCount(value, label) {
    const record = requireRecord(value, label);
    return {
        chunks: requireNonNegativeInteger(record.chunks, `${label}.chunks`),
        bytes: requireNonNegativeInteger(record.bytes, `${label}.bytes`),
        newlines: requireNonNegativeInteger(record.newlines, `${label}.newlines`),
    };
}
function parseIndex(value, chunkCount, totalBytes) {
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
        if (entry.seq !== position ||
            entry.startByte !== nextByte ||
            entry.endByte < entry.startByte ||
            entry.startLine !== nextLine ||
            entry.endLine < entry.startLine) {
            throw new ResultStoreError("corrupt", "terminal.index is not contiguous");
        }
        nextByte = entry.endByte;
        nextLine = entry.endLine;
    }
    if (nextByte !== totalBytes)
        throw new ResultStoreError("corrupt", "terminal.index byte total is invalid");
    return entries;
}
function parseManifestObject(object, expectedResultId) {
    const revision = requirePositiveRevision(object.revision, "manifest revision");
    const record = requireRecord(parseJson(object.data, "manifest"), "manifest");
    if (record.schemaVersion !== 1)
        throw new ResultStoreError("corrupt", "manifest schemaVersion is unsupported");
    const resultId = requireString(record.resultId, "manifest.resultId");
    if (resultId !== expectedResultId)
        throw new ResultStoreError("corrupt", "manifest resultId does not match its path");
    const identity = parseIdentity(record.identity);
    if (deriveResultId(identity) !== resultId)
        throw new ResultStoreError("corrupt", "manifest identity does not match resultId");
    const toolName = requireString(record.toolName, "manifest.toolName");
    const mediaType = requireString(record.mediaType, "manifest.mediaType");
    if (toolName.length === 0 || mediaType !== MEDIA_TYPE)
        throw new ResultStoreError("corrupt", "manifest metadata is invalid");
    const state = requireString(record.state, "manifest.state");
    const base = {
        schemaVersion: 1,
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
                committedChunkCount: requireNonNegativeInteger(record.committedChunkCount, "manifest.committedChunkCount"),
                committedTotalBytes: requireNonNegativeInteger(record.committedTotalBytes, "manifest.committedTotalBytes"),
            },
            revision,
        };
    }
    if (!["completed", "failed", "aborted", "unknown"].includes(state)) {
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
    if (countedChunks !== chunkCount ||
        countedBytes !== totalBytes ||
        countedNewlines !== indexedNewlines ||
        (totalBytes === 0
            ? totalLines !== 0 || countedNewlines !== 0
            : totalLines !== countedNewlines && totalLines !== countedNewlines + 1)) {
        throw new ResultStoreError("corrupt", "terminal aggregate counts are inconsistent");
    }
    return { manifest: { ...base, state, terminal }, revision };
}
function parseChunkObject(object, resultId, expectedSeq) {
    requirePositiveRevision(object.revision, `chunk ${expectedSeq} revision`);
    const record = requireRecord(parseJson(object.data, `chunk ${expectedSeq}`), `chunk ${expectedSeq}`);
    if (record.schemaVersion !== 1)
        throw new ResultStoreError("corrupt", `chunk ${expectedSeq} schema is unsupported`);
    const envelope = {
        schemaVersion: 1,
        resultId: requireString(record.resultId, `chunk ${expectedSeq}.resultId`),
        seq: requireNonNegativeInteger(record.seq, `chunk ${expectedSeq}.seq`),
        stream: requireString(record.stream, `chunk ${expectedSeq}.stream`),
        payloadLength: requireNonNegativeInteger(record.payloadLength, `chunk ${expectedSeq}.payloadLength`),
        payloadSha256: requireSha256(record.payloadSha256, `chunk ${expectedSeq}.payloadSha256`),
        payloadBase64: requireString(record.payloadBase64, `chunk ${expectedSeq}.payloadBase64`),
    };
    if (envelope.resultId !== resultId ||
        envelope.seq !== expectedSeq ||
        !["stdout", "stderr", "tool"].includes(envelope.stream)) {
        throw new ResultStoreError("corrupt", `chunk ${expectedSeq} envelope does not match its path`);
    }
    const payload = Buffer.from(envelope.payloadBase64, "base64");
    if (payload.toString("base64") !== envelope.payloadBase64 ||
        payload.length !== envelope.payloadLength ||
        createHash("sha256").update(payload).digest("hex") !== envelope.payloadSha256) {
        throw new ResultStoreError("corrupt", `chunk ${expectedSeq} payload is corrupt`);
    }
    try {
        UTF8_DECODER.decode(payload);
    }
    catch (error) {
        throw new ResultStoreError("corrupt", `chunk ${expectedSeq} payload is not UTF-8`, toError(error));
    }
    return envelope;
}
function chunkPayload(envelope) {
    return Buffer.from(envelope.payloadBase64, "base64");
}
function chunksMatch(left, right) {
    return (left.seq === right.seq &&
        left.stream === right.stream &&
        left.payloadLength === right.payloadLength &&
        left.payloadSha256 === right.payloadSha256);
}
function emptyStreamCount() {
    return { chunks: 0, bytes: 0, newlines: 0 };
}
function countNewlines(bytes) {
    let count = 0;
    for (const byte of bytes)
        if (byte === 0x0a)
            count += 1;
    return count;
}
function makeWritingManifest(resultId, input) {
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
function manifestsMatchBegin(manifest, input) {
    return (canonicalJson(manifest.identity) === canonicalJson(input.identity) &&
        manifest.toolName === input.toolName &&
        manifest.mediaType === input.mediaType);
}
function completeForState(state) {
    return state !== "writing" && state !== "unknown";
}
function statFromTerminal(manifest, revision) {
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
function terminalManifest(writing, input, aggregate) {
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
function terminalMatches(manifest, input, aggregate) {
    return (canonicalJson(manifest.terminal.finalizeInput) === canonicalJson(input) &&
        manifest.terminal.chunkCount === aggregate.chunkCount &&
        manifest.terminal.totalBytes === aggregate.totalBytes &&
        manifest.terminal.totalLines === aggregate.totalLines &&
        manifest.terminal.sha256 === aggregate.sha256 &&
        canonicalJson(manifest.terminal.streamCounts) === canonicalJson(aggregate.streamCounts) &&
        canonicalJson(manifest.terminal.index) === canonicalJson(aggregate.index));
}
function encodeCursor(value) {
    return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");
}
function decodeCursor(value, resultId, kind) {
    try {
        const parsed = requireRecord(JSON.parse(Buffer.from(value, "base64url").toString("utf8")), "cursor");
        if (parsed.v !== 1 || parsed.kind !== kind || parsed.resultId !== resultId) {
            throw new ResultStoreError("invalid", "cursor does not match this result or operation");
        }
        return parsed;
    }
    catch (error) {
        if (error instanceof ResultStoreError)
            throw error;
        throw new ResultStoreError("invalid", "cursor is invalid", toError(error));
    }
}
function foldCodePoint(value, caseSensitive) {
    return Array.from(caseSensitive ? value : value.toLowerCase());
}
function buildPrefixTable(pattern) {
    const prefix = new Array(pattern.length).fill(0);
    let matched = 0;
    for (let index = 1; index < pattern.length; index += 1) {
        while (matched > 0 && pattern[index] !== pattern[matched])
            matched = prefix[matched - 1] ?? 0;
        if (pattern[index] === pattern[matched])
            matched += 1;
        prefix[index] = matched;
    }
    return prefix;
}
function searchCursorQuery(query, caseSensitive) {
    return createHash("sha256").update(caseSensitive ? "1\0" : "0\0").update(query, "utf8").digest("hex");
}
class PersistentResultWriter {
    store;
    resultId;
    committedChunkCount;
    operationTail = Promise.resolve();
    constructor(store, resultId, committedChunkCount) {
        this.store = store;
        this.resultId = resultId;
        this.committedChunkCount = committedChunkCount;
    }
    get nextSeq() {
        return this.committedChunkCount;
    }
    async append(input) {
        await this.enqueue(async () => {
            this.committedChunkCount = await this.store.appendChunk(this.resultId, input);
        });
    }
    async finalize(input) {
        return await this.enqueue(async () => await this.store.finalizeResult(this.resultId, input));
    }
    async enqueue(operation) {
        const queued = this.operationTail.then(operation, operation);
        this.operationTail = queued.then(() => undefined, () => undefined);
        return await queued;
    }
}
export class PersistentToolResultStore {
    backend;
    pathPrefix;
    limits;
    resultMutationTails = new Map();
    constructor(options) {
        if (!options || !options.backend)
            throw new ResultStoreError("invalid", "backend is required");
        for (const method of ["create", "read", "replace"]) {
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
            maxSearchMatches: configuredLimit(options.maxSearchMatches, HARD_MAX_SEARCH_MATCHES, "maxSearchMatches"),
            maxSearchScanBytes: configuredLimit(options.maxSearchScanBytes, HARD_MAX_SEARCH_SCAN_BYTES, "maxSearchScanBytes"),
            maxSearchQueryBytes: configuredLimit(options.maxSearchQueryBytes, HARD_MAX_SEARCH_QUERY_BYTES, "maxSearchQueryBytes"),
            maxModelResponseBytes: configuredLimit(options.maxModelResponseBytes, HARD_MAX_MODEL_RESPONSE_BYTES, "maxModelResponseBytes"),
        };
    }
    async begin(input) {
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
        }
        catch (error) {
            const normalizedError = normalizeBackendError(error);
            if (normalizedError.code !== "conflict")
                throw normalizedError;
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
    async stat(resultId) {
        const normalized = normalizeResultId(resultId);
        const parsed = await this.readManifest(normalized);
        if (parsed.manifest.state !== "writing")
            return statFromTerminal(parsed.manifest, parsed.revision);
        return this.writingStat(parsed.manifest, parsed.revision, await this.aggregateWritingManifest(parsed.manifest));
    }
    async readLines(resultId, input) {
        const normalized = normalizeResultId(resultId);
        const record = inputRecord(input, "readLines input");
        const startLine = normalizeReadInteger(record.startLine, "startLine", 0);
        const maxLines = normalizeReadInteger(record.maxLines, "maxLines", 1, this.limits.maxReadLines);
        const maxBytes = normalizeReadInteger(record.maxBytes ?? this.limits.maxReadBytes, "maxBytes", 1, this.limits.maxReadBytes);
        if (record.allowIncomplete !== undefined && typeof record.allowIncomplete !== "boolean") {
            throw new ResultStoreError("invalid", "allowIncomplete must be boolean");
        }
        const parsed = await this.terminalForRead(normalized, record.allowIncomplete === true);
        const manifest = parsed.manifest;
        if (startLine >= manifest.terminal.totalLines) {
            return this.readPage(manifest, "", manifest.terminal.totalBytes, manifest.terminal.totalBytes, startLine, startLine);
        }
        const firstIndex = manifest.terminal.index.findIndex((entry) => entry.endLine >= startLine);
        if (firstIndex < 0)
            throw new ResultStoreError("corrupt", "line index does not contain startLine");
        let currentLine = manifest.terminal.index[firstIndex]?.startLine ?? 0;
        let currentByte = manifest.terminal.index[firstIndex]?.startByte ?? 0;
        let lineStartByte = currentByte;
        let pageStartByte;
        let pageEndByte = currentByte;
        let outputBytes = 0;
        const parts = [];
        const lineParts = [];
        let lineBytes = 0;
        let completedLines = 0;
        let stopped = false;
        for (let indexPosition = firstIndex; indexPosition < manifest.terminal.index.length && !stopped; indexPosition += 1) {
            const entry = manifest.terminal.index[indexPosition];
            if (!entry)
                throw new ResultStoreError("corrupt", "line index entry is missing");
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
        return this.readPage(manifest, text, pageStartByte ?? manifest.terminal.totalBytes, pageEndByte, startLine, endLine, pageEndByte < manifest.terminal.totalBytes
            ? encodeCursor({ kind: "lines", resultId: normalized, startLine: endLine, offset: pageEndByte })
            : undefined);
    }
    async readRange(resultId, input) {
        const normalized = normalizeResultId(resultId);
        const record = inputRecord(input, "readRange input");
        const offset = normalizeReadInteger(record.offset, "offset", 0);
        const length = normalizeReadInteger(record.length, "length", 1, this.limits.maxReadBytes);
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
    async search(resultId, input) {
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
        }
        catch (error) {
            throw new ResultStoreError("invalid", "query must be valid UTF-8", toError(error));
        }
        const maxMatches = normalizeReadInteger(record.maxMatches ?? Math.min(DEFAULT_SEARCH_MATCHES, this.limits.maxSearchMatches), "maxMatches", 1, this.limits.maxSearchMatches);
        const contextBytes = normalizeReadInteger(record.contextBytes ?? Math.min(DEFAULT_CONTEXT_BYTES, this.limits.maxModelResponseBytes), "contextBytes", 0, this.limits.maxModelResponseBytes);
        if (record.caseSensitive !== undefined && typeof record.caseSensitive !== "boolean") {
            throw new ResultStoreError("invalid", "caseSensitive must be boolean");
        }
        if (record.allowIncomplete !== undefined && typeof record.allowIncomplete !== "boolean") {
            throw new ResultStoreError("invalid", "allowIncomplete must be boolean");
        }
        const caseSensitive = record.caseSensitive ?? true;
        const queryKey = searchCursorQuery(query, caseSensitive);
        const parsed = await this.terminalForRead(normalized, record.allowIncomplete === true);
        const manifest = parsed.manifest;
        const cursor = record.cursor === undefined ? undefined : decodeCursor(inputString(record.cursor, "cursor"), normalized, "search");
        if (cursor !== undefined && cursor.query !== queryKey) {
            throw new ResultStoreError("invalid", "cursor does not match this search query");
        }
        const scanStart = cursor === undefined ? 0 : normalizeReadInteger(cursor.offset, "cursor.offset", 0, manifest.terminal.totalBytes);
        if (scanStart >= manifest.terminal.totalBytes) {
            return this.searchPage(manifest, [], 0);
        }
        const desiredEnd = Math.min(scanStart + this.limits.maxSearchScanBytes, manifest.terminal.totalBytes);
        const primaryEnd = await this.utf8BoundaryAtOrBefore(manifest, scanStart, desiredEnd);
        if (primaryEnd <= scanStart) {
            throw new ResultStoreError("limit_exceeded", "maxSearchScanBytes cannot contain the next UTF-8 code point");
        }
        const pattern = Array.from(query).flatMap((codePoint) => foldCodePoint(codePoint, caseSensitive));
        if (pattern.length === 0)
            throw new ResultStoreError("invalid", "query folds to an empty pattern");
        const lookaheadEnd = Math.min(primaryEnd + pattern.length * 4, manifest.terminal.totalBytes);
        const alignedLookaheadEnd = await this.utf8BoundaryAtOrBefore(manifest, primaryEnd, lookaheadEnd);
        const scanBytes = await this.readPayloadRange(manifest, scanStart, alignedLookaheadEnd);
        const scanText = UTF8_DECODER.decode(scanBytes);
        const prefix = buildPrefixTable(pattern);
        const ringStarts = new Array(pattern.length).fill(0);
        const ringEnds = new Array(pattern.length).fill(0);
        const ringLines = new Array(pattern.length).fill(0);
        let patternState = 0;
        let foldedIndex = 0;
        let sourceByte = scanStart;
        let sourceLine = await this.lineAtByte(manifest, scanStart);
        let nextCursorOffset;
        const hits = [];
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
                if (foldedCodePoint === pattern[patternState])
                    patternState += 1;
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
            if (sourceCodePoint === "\n")
                sourceLine += 1;
            if (sourceByte >= alignedLookaheadEnd)
                break;
        }
        if (nextCursorOffset === undefined && primaryEnd < manifest.terminal.totalBytes)
            nextCursorOffset = primaryEnd;
        let responseBudget = this.limits.maxModelResponseBytes;
        const matches = [];
        for (const hit of hits) {
            const requestedContext = Math.min(contextBytes, responseBudget);
            const text = requestedContext === 0
                ? ""
                : await this.readContext(manifest, hit.byteOffset, hit.endByte, requestedContext);
            responseBudget -= Buffer.byteLength(text, "utf8");
            matches.push({ byteOffset: hit.byteOffset, line: hit.line, text });
        }
        const scannedBytes = Math.max(0, Math.min(sourceByte, primaryEnd) - scanStart);
        return this.searchPage(manifest, matches, scannedBytes, nextCursorOffset === undefined
            ? undefined
            : encodeCursor({ kind: "search", resultId: normalized, query: queryKey, offset: nextCursorOffset }));
    }
    async recover(resultId, input) {
        const normalized = normalizeResultId(resultId);
        return await this.serializeResultMutation(normalized, async () => await this.recoverUnlocked(normalized, input));
    }
    async recoverUnlocked(normalized, input) {
        const record = inputRecord(input, "recover input");
        if (record.action !== "mark_unknown" ||
            typeof record.reason !== "string" ||
            record.reason.length === 0 ||
            hasUnpairedSurrogate(record.reason)) {
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
            if (current.manifest.state === "unknown" &&
                finalize.error?.code === recoveryError.code &&
                finalize.error.message === recoveryError.message) {
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
    async appendChunk(resultId, input) {
        const normalized = normalizeResultId(resultId);
        return await this.serializeResultMutation(normalized, async () => await this.appendChunkUnlocked(normalized, input));
    }
    async appendChunkUnlocked(normalized, input) {
        const record = inputRecord(input, "append input");
        if (!Number.isSafeInteger(record.seq) || record.seq < 0) {
            throw new ResultStoreError("invalid", "seq must be a non-negative safe integer");
        }
        if (record.seq >= this.limits.maxChunks) {
            throw new ResultStoreError("limit_exceeded", `seq must be between 0 and ${this.limits.maxChunks - 1}`);
        }
        const seq = record.seq;
        const stream = record.stream;
        if (!["stdout", "stderr", "tool"].includes(stream)) {
            throw new ResultStoreError("invalid", "stream is invalid");
        }
        if (!(record.data instanceof Uint8Array))
            throw new ResultStoreError("invalid", "data must be Uint8Array");
        const payload = Buffer.from(record.data);
        if (payload.length > this.limits.maxChunkBytes) {
            throw new ResultStoreError("limit_exceeded", `chunk exceeds ${this.limits.maxChunkBytes} bytes`);
        }
        try {
            UTF8_DECODER.decode(payload);
        }
        catch (error) {
            throw new ResultStoreError("invalid", "chunk data must be independently valid UTF-8", toError(error));
        }
        const envelope = {
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
            throw new ResultStoreError("conflict", `chunk ${seq} creates a gap after committed chunk ${current.manifest.committedChunkCount - 1}`);
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
        }
        catch (error) {
            const normalizedError = normalizeBackendError(error);
            if (normalizedError.code !== "conflict")
                throw normalizedError;
            await this.requireMatchingChunk(normalized, envelope);
        }
        const committed = {
            ...current.manifest,
            committedChunkCount: current.manifest.committedChunkCount + 1,
            committedTotalBytes: current.manifest.committedTotalBytes + payload.length,
        };
        try {
            const replaced = await this.backendCall(async () => await this.backend.replace(this.manifestPath(normalized), jsonBytes(committed), current.revision));
            requirePositiveRevision(replaced.revision, "manifest revision");
            return committed.committedChunkCount;
        }
        catch (error) {
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
    async finalizeResult(resultId, input) {
        const normalized = normalizeResultId(resultId);
        return await this.serializeResultMutation(normalized, async () => await this.finalizeResultUnlocked(normalized, input));
    }
    async finalizeResultUnlocked(normalized, input) {
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
            throw new ResultStoreError("conflict", `finalize expected ${normalizedInput.chunkCount} chunks, manifest committed ${current.manifest.committedChunkCount}`);
        }
        const aggregate = await this.aggregateWritingManifest(current.manifest);
        const terminal = terminalManifest(current.manifest, normalizedInput, aggregate);
        try {
            const replaced = await this.backendCall(async () => await this.backend.replace(this.manifestPath(normalized), jsonBytes(terminal), current.revision));
            return statFromTerminal(terminal, requirePositiveRevision(replaced.revision, "manifest revision"));
        }
        catch (error) {
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
    async backendCall(operation) {
        try {
            return await operation();
        }
        catch (error) {
            throw normalizeBackendError(error);
        }
    }
    async serializeResultMutation(resultId, operation) {
        const previous = this.resultMutationTails.get(resultId) ?? Promise.resolve();
        const running = previous.then(operation, operation);
        const tail = running.then(() => undefined, () => undefined);
        this.resultMutationTails.set(resultId, tail);
        try {
            return await running;
        }
        finally {
            if (this.resultMutationTails.get(resultId) === tail)
                this.resultMutationTails.delete(resultId);
        }
    }
    resultDirectory(resultId) {
        const digest = resultId.slice(3);
        return `${this.pathPrefix}/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${resultId}`;
    }
    manifestPath(resultId) {
        return `${this.resultDirectory(resultId)}/manifest.json`;
    }
    chunksPrefix(resultId) {
        return `${this.resultDirectory(resultId)}/chunks/`;
    }
    chunkPath(resultId, sequence) {
        return `${this.chunksPrefix(resultId)}${sequence.toString().padStart(12, "0")}.json`;
    }
    async readManifest(resultId) {
        const object = await this.backendCall(async () => await this.backend.read(this.manifestPath(resultId)));
        const parsed = parseManifestObject(object, resultId);
        const chunkCount = parsed.manifest.state === "writing"
            ? parsed.manifest.committedChunkCount
            : parsed.manifest.terminal.chunkCount;
        const totalBytes = parsed.manifest.state === "writing"
            ? parsed.manifest.committedTotalBytes
            : parsed.manifest.terminal.totalBytes;
        if (chunkCount > this.limits.maxChunks || totalBytes > this.limits.maxResultBytes) {
            throw new ResultStoreError("limit_exceeded", "stored result exceeds configured limits");
        }
        return parsed;
    }
    async readVerifiedChunk(resultId, sequence) {
        const envelope = await this.readChunkEnvelope(resultId, sequence);
        if (envelope.payloadLength > this.limits.maxChunkBytes) {
            throw new ResultStoreError("limit_exceeded", `chunk ${sequence} exceeds maxChunkBytes`);
        }
        return chunkPayload(envelope);
    }
    async requireMatchingChunk(resultId, expected) {
        const existing = await this.readChunkEnvelope(resultId, expected.seq);
        if (!chunksMatch(existing, expected)) {
            throw new ResultStoreError("conflict", `chunk ${expected.seq} already exists with different content`);
        }
    }
    async readChunkEnvelope(resultId, sequence) {
        let object;
        try {
            object = await this.backendCall(async () => await this.backend.read(this.chunkPath(resultId, sequence)));
        }
        catch (error) {
            const normalized = normalizeBackendError(error);
            if (normalized.code === "not_found") {
                throw new ResultStoreError("incomplete", `chunk ${sequence} is missing`, normalized);
            }
            throw normalized;
        }
        return parseChunkObject(object, resultId, sequence);
    }
    emptyAggregate() {
        return {
            chunkCount: 0,
            totalBytes: 0,
            totalLines: 0,
            sha256: createHash("sha256").digest("hex"),
            streamCounts: { stdout: emptyStreamCount(), stderr: emptyStreamCount(), tool: emptyStreamCount() },
            index: [],
        };
    }
    async aggregateChunks(resultId, chunkCount) {
        const aggregateHash = createHash("sha256");
        const streamCounts = { stdout: emptyStreamCount(), stderr: emptyStreamCount(), tool: emptyStreamCount() };
        const index = [];
        let totalBytes = 0;
        let totalNewlines = 0;
        let finalByte;
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
            if (payload.length > 0)
                finalByte = payload[payload.length - 1];
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
    async aggregateWritingManifest(manifest) {
        const aggregate = await this.aggregateChunks(manifest.resultId, manifest.committedChunkCount);
        if (aggregate.totalBytes !== manifest.committedTotalBytes) {
            throw new ResultStoreError("corrupt", "writing manifest committed byte total is inconsistent");
        }
        return aggregate;
    }
    writingStat(manifest, revision, aggregate) {
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
    async terminalForRead(resultId, allowIncomplete) {
        const parsed = await this.readManifest(resultId);
        if (parsed.manifest.state === "writing") {
            throw new ResultStoreError("incomplete", "writing results cannot be read");
        }
        if (parsed.manifest.state === "unknown" && !allowIncomplete) {
            throw new ResultStoreError("incomplete", "unknown results require allowIncomplete");
        }
        return { manifest: parsed.manifest };
    }
    async readPayloadRange(manifest, startByte, endByte) {
        if (startByte < 0 || endByte < startByte || endByte > manifest.terminal.totalBytes) {
            throw new ResultStoreError("invalid", "payload range is invalid");
        }
        if (startByte === endByte)
            return new Uint8Array();
        const parts = [];
        let collected = 0;
        for (const entry of manifest.terminal.index) {
            if (entry.endByte <= startByte)
                continue;
            if (entry.startByte >= endByte)
                break;
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
        if (collected !== endByte - startByte)
            throw new ResultStoreError("corrupt", "payload range is incomplete");
        return Buffer.concat(parts, collected);
    }
    readPage(manifest, text, startByte, endByte, startLine, endLine, nextCursor) {
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
    searchPage(manifest, matches, scannedBytes, nextCursor) {
        return {
            resultId: manifest.resultId,
            state: manifest.state,
            complete: completeForState(manifest.state),
            matches,
            scannedBytes,
            ...(nextCursor === undefined ? {} : { nextCursor }),
        };
    }
    async utf8BoundaryAtOrBefore(manifest, minimum, desired) {
        if (desired >= manifest.terminal.totalBytes)
            return manifest.terminal.totalBytes;
        let boundary = desired;
        while (boundary > minimum) {
            const next = await this.readPayloadRange(manifest, boundary, boundary + 1);
            const byte = next[0];
            if (byte === undefined || (byte & 0xc0) !== 0x80)
                return boundary;
            boundary -= 1;
        }
        return boundary;
    }
    async lineAtByte(manifest, offset) {
        if (offset <= 0)
            return 0;
        if (offset >= manifest.terminal.totalBytes)
            return manifest.terminal.totalLines;
        const entry = manifest.terminal.index.find((candidate) => candidate.endByte > offset);
        if (!entry)
            throw new ResultStoreError("corrupt", "line index does not contain byte offset");
        const prefix = await this.readPayloadRange(manifest, entry.startByte, offset);
        return entry.startLine + countNewlines(prefix);
    }
    async readContext(manifest, byteOffset, matchEndByte, maximumBytes) {
        if (maximumBytes <= 0)
            return "";
        const matchBytes = Math.max(0, matchEndByte - byteOffset);
        const before = Math.floor(Math.max(0, maximumBytes - Math.min(matchBytes, maximumBytes)) / 2);
        let start = Math.max(0, byteOffset - before);
        let end = Math.min(manifest.terminal.totalBytes, start + maximumBytes);
        if (end - start < maximumBytes)
            start = Math.max(0, end - maximumBytes);
        const bytes = Buffer.from(await this.readPayloadRange(manifest, start, end));
        let localStart = 0;
        while (localStart < bytes.length && (bytes[localStart] & 0xc0) === 0x80)
            localStart += 1;
        let localEnd = bytes.length;
        while (localEnd > localStart) {
            try {
                return UTF8_DECODER.decode(bytes.subarray(localStart, localEnd));
            }
            catch {
                localEnd -= 1;
            }
        }
        return "";
    }
}
//# sourceMappingURL=tool-result-store.js.map