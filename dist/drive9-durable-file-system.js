import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { err, FileError, ok, } from "@earendil-works/pi-durable/env";
import { normalizeDrive9AbsoluteRoot, normalizeDrive9PathText } from "./drive9-path.js";
/**
 * Cancellation bridge: Pi 1.0 threads a Chord {@link Context} through every
 * call instead of the old optional `AbortSignal`. We read `context.abortSignal`
 * and propagate it into Drive9 SDK calls that accept one.
 */
function contextSignal(context) {
    return context?.abortSignal;
}
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const FILE_TYPE_MASK = 0o170000;
const SYMLINK_TYPE = 0o120000;
function isStatusError(error) {
    return (typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        typeof error.statusCode === "number");
}
function statusCode(error) {
    if (isStatusError(error))
        return error.statusCode;
    if (typeof error !== "object" || error === null || !("status" in error))
        return undefined;
    const status = error.status;
    return typeof status === "number" ? status : undefined;
}
function errorValue(value) {
    if (value instanceof Error)
        return value;
    return new Error(typeof value === "string" ? value : String(value));
}
function errorMessage(value) {
    return errorValue(value).message.toLowerCase();
}
function isMissing(value) {
    return statusCode(value) === 404 || errorMessage(value).includes("not found");
}
function isConflict(value) {
    const message = errorMessage(value);
    return statusCode(value) === 409 || message.includes("already exists");
}
function toFileError(value, path) {
    if (value instanceof FileError)
        return value;
    const cause = errorValue(value);
    const message = cause.message.toLowerCase();
    if (cause.name === "AbortError")
        return new FileError("aborted", cause.message, path, cause);
    if (isMissing(value))
        return new FileError("not_found", cause.message, path, cause);
    if (message.includes("not a directory"))
        return new FileError("not_directory", cause.message, path, cause);
    if (message.includes("is a directory"))
        return new FileError("is_directory", cause.message, path, cause);
    switch (statusCode(value)) {
        case 400:
        case 409:
        case 412:
        case 413:
        case 422:
            return new FileError("invalid", cause.message, path, cause);
        case 401:
        case 403:
            return new FileError("permission_denied", cause.message, path, cause);
        case 405:
        case 501:
            return new FileError("not_supported", cause.message, path, cause);
        default:
            return new FileError("unknown", cause.message, path, cause);
    }
}
function normalizeRoot(value, label) {
    return normalizeDrive9AbsoluteRoot(value, label, (message) => new TypeError(message));
}
function isWithin(root, path) {
    return path === root || path.startsWith(`${root}/`);
}
function validateComponent(value, label, options = {}) {
    const code = options.backend === true ? "unknown" : "invalid";
    const normalized = normalizeDrive9PathText(value, label, options.allowEmpty ?? true, (message) => new FileError(code, message));
    if (normalized === "." || normalized === ".." || normalized.includes("/")) {
        throw new FileError(code, `${label} must be a single path component`);
    }
    return normalized;
}
function fileKind(mode, isDir) {
    if (mode !== undefined && (mode & FILE_TYPE_MASK) === SYMLINK_TYPE)
        return "symlink";
    return isDir ? "directory" : "file";
}
function modificationTime(value) {
    const time = value?.getTime() ?? 0;
    return Number.isFinite(time) ? time : 0;
}
function materializeInfo(path, info) {
    return {
        name: posix.basename(path),
        path,
        kind: fileKind(info.mode, info.isDir),
        size: info.size,
        mtimeMs: modificationTime(info.mtime),
    };
}
function decodeUtf8(decoder, path, bytes, stream = false) {
    try {
        return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream });
    }
    catch (error) {
        throw new FileError("invalid", "file is not valid UTF-8", path, errorValue(error));
    }
}
export class Drive9DurableFileSystem {
    /**
     * Pi 1.0 namespace identity: equal ids see the same files at the same paths.
     * Derived from the Drive9 namespace (server/tenant/root), NOT the JS instance,
     * so two adapters onto the same namespace share an id and a forked workspace
     * gets a different one. Pi uses this to serialize file mutations.
     */
    id;
    root;
    tempRoot;
    client;
    currentWorkingDirectory;
    temporaryPaths = new Map();
    mutationTail = Promise.resolve();
    constructor(options) {
        this.client = options.client;
        this.root = normalizeRoot(options.root, "root");
        this.currentWorkingDirectory = normalizeRoot(options.cwd ?? this.root, "cwd");
        this.tempRoot = normalizeRoot(options.tempRoot ?? posix.join(this.root, ".drive9-pi-tmp"), "tempRoot");
        if (!isWithin(this.root, this.currentWorkingDirectory))
            throw new TypeError("cwd must be inside root");
        if (!isWithin(this.root, this.tempRoot))
            throw new TypeError("tempRoot must be inside root");
        this.id = options.id ?? `drive9:${this.root}`;
    }
    get cwd() {
        return this.currentWorkingDirectory;
    }
    set cwd(value) {
        const normalized = normalizeRoot(value, "cwd");
        if (!isWithin(this.root, normalized))
            throw new TypeError("cwd must be inside root");
        this.currentWorkingDirectory = normalized;
    }
    async absolutePath(path, context) {
        return await this.operation(path, context, async () => this.addressedPath(path));
    }
    async joinPath(parts, context) {
        return await this.operation(undefined, context, async () => {
            if (!Array.isArray(parts))
                throw new FileError("invalid", "path parts must be an array");
            const normalized = parts.map((part) => normalizeDrive9PathText(part, "path part", true, (message) => new FileError("invalid", message)));
            return this.addressedPath(posix.join(...normalized));
        });
    }
    async readTextFile(path, context) {
        const result = await this.readBinaryFile(path, context);
        if (!result.ok)
            return result;
        try {
            return ok(TEXT_DECODER.decode(result.value));
        }
        catch (error) {
            return err(new FileError("invalid", "file is not valid UTF-8", this.safeAddress(path), errorValue(error)));
        }
    }
    async readTextLines(path, options, context) {
        if (options?.maxLines !== undefined && (!Number.isSafeInteger(options.maxLines) || options.maxLines < 0)) {
            return err(new FileError("invalid", "maxLines must be a non-negative integer", this.safeAddress(path)));
        }
        return await this.operation(path, context, async () => {
            const addressed = this.addressedPath(path);
            if (options?.maxLines === 0)
                return [];
            await this.assertReadableFile(addressed);
            if (this.client.readStream !== undefined) {
                return await this.readTextLinesFromStream(addressed, options?.maxLines, contextSignal(context));
            }
            const text = decodeUtf8(new TextDecoder("utf-8", { fatal: true }), addressed, await this.client.read(addressed));
            const lines = text.split(/\r?\n/);
            if (lines.at(-1) === "")
                lines.pop();
            return options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines);
        });
    }
    /**
     * Stream a file line-by-line from Drive9. Incremental UTF-8 decode; preserves
     * an unterminated final line; cancels the remote reader on close/abort. Does
     * NOT read the whole file then split. Requires the SDK `readStream`; without
     * it we fail closed with `not_supported` rather than silently buffering.
     */
    async openTextLineReader(path, context) {
        const aborted = this.aborted(context, this.safeAddress(path));
        if (aborted !== undefined)
            return aborted;
        if (this.client.readStream === undefined) {
            return err(new FileError("not_supported", "streaming line reads require Drive9 Client.readStream", this.safeAddress(path)));
        }
        let addressed;
        try {
            addressed = this.addressedPath(path);
            await this.assertReadableFile(addressed);
        }
        catch (error) {
            return err(toFileError(error, this.safeAddress(path)));
        }
        try {
            const stream = await this.client.readStream(addressed);
            return ok(new Drive9TextLineReader(stream, addressed));
        }
        catch (error) {
            return err(toFileError(error, addressed));
        }
    }
    async readBinaryFile(path, context) {
        return await this.operation(path, context, async () => {
            const addressed = this.addressedPath(path);
            await this.assertReadableFile(addressed);
            return Uint8Array.from(await this.client.read(addressed));
        });
    }
    async writeFile(path, content, context) {
        return await this.mutate(path, context, async () => {
            const addressed = this.addressedPath(path);
            if (addressed === this.root)
                throw new FileError("permission_denied", "workspace root cannot be overwritten", addressed);
            await this.ensureParents(addressed);
            const existing = await this.optionalInfo(addressed);
            if (existing?.kind === "directory")
                throw new FileError("is_directory", "path is a directory", addressed);
            if (existing?.kind === "symlink")
                throw new FileError("not_supported", "symlink writes are not supported", addressed);
            const data = typeof content === "string" ? Buffer.from(content, "utf8") : Uint8Array.from(content);
            await this.client.write(addressed, data);
        });
    }
    async appendFile(path, content, context) {
        return await this.mutate(path, context, async () => {
            const addressed = this.addressedPath(path);
            if (addressed === this.root)
                throw new FileError("permission_denied", "workspace root cannot be appended", addressed);
            await this.ensureParents(addressed);
            const existing = await this.optionalInfo(addressed);
            if (existing?.kind === "directory")
                throw new FileError("is_directory", "path is a directory", addressed);
            if (existing?.kind === "symlink")
                throw new FileError("not_supported", "symlink appends are not supported", addressed);
            const data = typeof content === "string" ? Buffer.from(content, "utf8") : Uint8Array.from(content);
            await this.client.append(addressed, data);
        });
    }
    /**
     * Truncate or extend a file to exactly `size` bytes.
     *
     * The Drive9 SDK/server has NO truncate primitive — only a whole-object PUT
     * (create+truncate semantics) via `write`. We honor ONLY the `size === 0`
     * case, which a zero-byte write expresses exactly. For any other size we
     * return `not_supported` rather than emulate truncate with a read-modify-write
     * (which would silently race concurrent writers, double the data transfer, and
     * misrepresent a missing primitive as present). A real `truncateFile(path,size)`
     * must be added to the Drive9 server/SDK before this can be a stable capability.
     */
    async truncateFile(path, size, context) {
        if (!Number.isSafeInteger(size) || size < 0) {
            return err(new FileError("invalid", "size must be a non-negative integer", this.safeAddress(path)));
        }
        if (size !== 0) {
            return err(new FileError("not_supported", "Drive9 has no native truncate-to-size primitive; only truncation to 0 bytes is supported", this.safeAddress(path)));
        }
        return await this.mutate(path, context, async () => {
            const addressed = this.addressedPath(path);
            if (addressed === this.root)
                throw new FileError("permission_denied", "workspace root cannot be truncated", addressed);
            const existing = await this.optionalInfo(addressed);
            if (existing?.kind === "directory")
                throw new FileError("is_directory", "path is a directory", addressed);
            if (existing?.kind === "symlink")
                throw new FileError("not_supported", "symlink truncation is not supported", addressed);
            await this.ensureParents(addressed);
            await this.client.write(addressed, new Uint8Array(0));
        });
    }
    /**
     * Flush file contents + metadata so they are retrievable from another handle.
     *
     * Drive9 has no open-file-handle model and no explicit fsync: a `write`/`append`
     * PUT is acknowledged only AFTER the server commits the revision (the ack IS
     * the durability barrier — an acknowledged write is already retrievable by
     * another process). There is therefore no buffered state for `flushFile` to
     * force, so it is a confirmation no-op. We deliberately do NOT call `stat()`
     * here: a stat would be a fake fsync that proves nothing about durability.
     */
    async flushFile(path, context) {
        return await this.operation(path, context, async () => {
            const addressed = this.addressedPath(path);
            if (addressed === this.root)
                throw new FileError("is_directory", "path is a directory", addressed);
            return undefined;
        });
    }
    async renameFile(sourcePath, destinationPath, context) {
        return await this.mutate(sourcePath, context, async () => {
            const source = this.addressedPath(sourcePath);
            const destination = this.addressedPath(destinationPath);
            if (source === this.root || destination === this.root) {
                throw new FileError("permission_denied", "workspace root cannot be renamed or replaced", source);
            }
            await this.statInfo(source);
            const parent = await this.statInfo(posix.dirname(destination));
            if (parent.kind !== "directory") {
                throw new FileError("not_directory", "destination parent is not a directory", parent.path);
            }
            await this.client.rename(source, destination);
        });
    }
    async fileInfo(path, context) {
        return await this.operation(path, context, async () => await this.statInfo(this.addressedPath(path)));
    }
    async listDir(path, context) {
        return await this.operation(path, context, async () => {
            const addressed = this.addressedPath(path);
            const directory = await this.statInfo(addressed);
            if (directory.kind !== "directory")
                throw new FileError("not_directory", "path is not a directory", addressed);
            const childPaths = new Set();
            const children = (await this.client.list(addressed)).map((entry) => {
                const name = validateComponent(entry.name, "Drive9 directory child", { allowEmpty: false, backend: true });
                const childPath = posix.join(addressed, name);
                if (childPaths.has(childPath)) {
                    throw new FileError("unknown", "Drive9 returned duplicate directory children after NFC normalization", addressed);
                }
                childPaths.add(childPath);
                return materializeInfo(childPath, entry);
            });
            return children.sort((left, right) => left.name.localeCompare(right.name));
        });
    }
    async canonicalPath(path, context) {
        const info = await this.fileInfo(path, context);
        if (!info.ok)
            return info;
        if (info.value.kind === "symlink") {
            return err(new FileError("not_supported", "Drive9 SDK does not expose symlink canonicalization", info.value.path));
        }
        return ok(info.value.path);
    }
    async exists(path, context) {
        const info = await this.fileInfo(path, context);
        if (info.ok)
            return ok(true);
        return info.error.code === "not_found" ? ok(false) : info;
    }
    async createDir(path, options, context) {
        return await this.mutate(path, context, async () => {
            const addressed = this.addressedPath(path);
            if (addressed === this.root)
                return;
            if (options?.recursive ?? true) {
                for (const current of this.pathSegments(addressed))
                    await this.ensureDirectory(current);
                return;
            }
            const parent = await this.statInfo(posix.dirname(addressed));
            if (parent.kind !== "directory")
                throw new FileError("not_directory", "parent is not a directory", parent.path);
            await this.ensureDirectory(addressed);
        });
    }
    async remove(path, options, context) {
        return await this.mutate(path, context, async () => {
            const addressed = this.addressedPath(path);
            if (addressed === this.root)
                throw new FileError("permission_denied", "workspace root cannot be removed", addressed);
            const info = await this.optionalInfo(addressed);
            if (info === undefined) {
                if (options?.force === true)
                    return;
                throw new FileError("not_found", "path does not exist", addressed);
            }
            if (options?.recursive === true) {
                await this.client.removeAll(addressed);
                return;
            }
            if (info.kind === "directory") {
                const children = await this.client.list(addressed);
                if (children.length > 0)
                    throw new FileError("invalid", "directory is not empty", addressed);
                await this.client.deleteDir(addressed);
                return;
            }
            await this.client.deleteFile(addressed);
        });
    }
    async createTempDir(prefix, context) {
        try {
            return await this.createTemporaryPath(validateComponent(prefix ?? "tmp-", "prefix"), "", true, context);
        }
        catch (error) {
            return err(toFileError(error, this.tempRoot));
        }
    }
    async createTempFile(options, context) {
        let prefix;
        let suffix;
        try {
            prefix = validateComponent(options?.prefix ?? "", "prefix");
            suffix = validateComponent(options?.suffix ?? "", "suffix");
        }
        catch (error) {
            return err(toFileError(error, this.tempRoot));
        }
        return await this.createTemporaryPath(prefix, suffix, false, context);
    }
    async cleanup(context) {
        const paths = [...this.temporaryPaths.entries()].sort(([left], [right]) => right.length - left.length);
        for (const [path, directory] of paths) {
            try {
                const removed = await this.remove(path, { recursive: directory, force: true }, context);
                if (removed.ok)
                    this.temporaryPaths.delete(path);
            }
            catch { }
        }
    }
    addressedPath(path) {
        const transportSafe = normalizeDrive9PathText(path, "path", false, (message) => new FileError("invalid", message));
        const addressed = posix.normalize(posix.isAbsolute(transportSafe) ? transportSafe : posix.resolve(this.cwd, transportSafe));
        if (!isWithin(this.root, addressed))
            throw new FileError("permission_denied", "path escapes Drive9 root", addressed);
        return addressed;
    }
    safeAddress(path) {
        try {
            return this.addressedPath(path);
        }
        catch {
            return undefined;
        }
    }
    aborted(context, path) {
        return contextSignal(context)?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
    }
    async operation(path, context, operation) {
        const abort = this.aborted(context, path === undefined ? undefined : this.safeAddress(path));
        if (abort !== undefined)
            return abort;
        try {
            return ok(await operation());
        }
        catch (error) {
            return err(toFileError(error, path === undefined ? undefined : this.safeAddress(path)));
        }
    }
    async mutate(path, context, operation) {
        const run = async () => await this.operation(path, context, operation);
        const running = this.mutationTail.then(run, run);
        this.mutationTail = running.then(() => undefined, () => undefined);
        return await running;
    }
    async assertReadableFile(path) {
        const info = await this.statInfo(path);
        if (info.kind === "directory")
            throw new FileError("is_directory", "path is a directory", path);
        if (info.kind === "symlink")
            throw new FileError("not_supported", "symlink reads are not supported", path);
    }
    async readTextLinesFromStream(path, maxLines, signal) {
        const stream = await this.client.readStream(path);
        if (signal?.aborted) {
            try {
                await stream.cancel("aborted");
            }
            catch { }
            throw new FileError("aborted", "aborted", path);
        }
        const reader = stream.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const lines = [];
        let pending = "";
        let settled = false;
        const onAbort = () => {
            void reader.cancel("aborted").catch(() => undefined);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            while (true) {
                const chunk = await reader.read();
                if (signal?.aborted)
                    throw new FileError("aborted", "aborted", path);
                pending += chunk.done ? decodeUtf8(decoder, path) : decodeUtf8(decoder, path, chunk.value, true);
                let newline = pending.indexOf("\n");
                while (newline >= 0) {
                    let line = pending.slice(0, newline);
                    if (line.endsWith("\r"))
                        line = line.slice(0, -1);
                    pending = pending.slice(newline + 1);
                    lines.push(line);
                    if (maxLines !== undefined && lines.length >= maxLines) {
                        try {
                            await reader.cancel("maxLines reached");
                        }
                        catch { }
                        if (signal?.aborted)
                            throw new FileError("aborted", "aborted", path);
                        settled = true;
                        return lines;
                    }
                    newline = pending.indexOf("\n");
                }
                if (chunk.done) {
                    if (pending.length > 0)
                        lines.push(pending);
                    settled = true;
                    return lines;
                }
            }
        }
        catch (error) {
            if (signal?.aborted)
                throw new FileError("aborted", "aborted", path, errorValue(error));
            throw error;
        }
        finally {
            signal?.removeEventListener("abort", onAbort);
            if (!settled) {
                try {
                    await reader.cancel("read did not complete");
                }
                catch { }
            }
            reader.releaseLock();
        }
    }
    async statInfo(path) {
        return materializeInfo(path, await this.client.stat(path));
    }
    async optionalInfo(path) {
        try {
            return await this.statInfo(path);
        }
        catch (error) {
            if (isMissing(error))
                return undefined;
            throw error;
        }
    }
    pathSegments(path) {
        const parts = posix.relative(this.root, path).split("/").filter((part) => part.length > 0);
        return parts.map((_part, index) => posix.join(this.root, ...parts.slice(0, index + 1)));
    }
    async ensureParents(path) {
        for (const parent of this.pathSegments(posix.dirname(path)))
            await this.ensureDirectory(parent);
    }
    async ensureDirectory(path) {
        const existing = await this.optionalInfo(path);
        if (existing !== undefined) {
            if (existing.kind !== "directory")
                throw new FileError("not_directory", "path component is not a directory", path);
            return;
        }
        try {
            await this.client.mkdir(path, 0o755);
        }
        catch (error) {
            const concurrent = await this.optionalInfo(path);
            if (concurrent?.kind === "directory")
                return;
            throw error;
        }
    }
    async createTemporaryPath(prefix, suffix, directory, context) {
        const tempDirectory = await this.createDir(this.tempRoot, { recursive: true }, context);
        if (!tempDirectory.ok)
            return tempDirectory;
        for (let attempt = 0; attempt < 32; attempt += 1) {
            const path = posix.join(this.tempRoot, `${prefix}${randomUUID()}${suffix}`);
            const created = await this.mutate(path, context, async () => {
                try {
                    if (directory)
                        await this.client.mkdir(path, 0o700);
                    else {
                        if (this.client.createFile === undefined) {
                            throw new FileError("not_supported", "atomic temporary files require Drive9 Client.createFile", path);
                        }
                        await this.client.createFile(path);
                    }
                }
                catch (error) {
                    if (isConflict(error))
                        return false;
                    throw error;
                }
                return true;
            });
            if (!created.ok)
                return created;
            if (!created.value)
                continue;
            this.temporaryPaths.set(path, directory);
            return ok(path);
        }
        return err(new FileError("unknown", "could not allocate a unique temporary path", this.tempRoot));
    }
}
/**
 * Streaming line reader over a Drive9 `ReadableStream<Uint8Array>`.
 *
 * Decodes UTF-8 incrementally and yields one line per `readLine`, flagging
 * whether each line was newline-`terminated`. A trailing unterminated line is
 * returned with `terminated: false`; EOF then yields `undefined`. Cancellation
 * via `context.abortSignal` and `close()` both cancel the underlying reader so
 * the remote stream is not left open. It never buffers the whole file.
 */
class Drive9TextLineReader {
    path;
    reader;
    decoder = new TextDecoder("utf-8", { fatal: true });
    pending = "";
    streamDone = false;
    closed = false;
    constructor(stream, path) {
        this.path = path;
        this.reader = stream.getReader();
    }
    async readLine(context) {
        if (this.closed)
            return ok(undefined);
        const signal = contextSignal(context);
        try {
            while (true) {
                if (signal?.aborted) {
                    await this.close(context);
                    return err(new FileError("aborted", "aborted", this.path));
                }
                const newline = this.pending.indexOf("\n");
                if (newline >= 0) {
                    let text = this.pending.slice(0, newline);
                    if (text.endsWith("\r"))
                        text = text.slice(0, -1);
                    this.pending = this.pending.slice(newline + 1);
                    return ok({ text, terminated: true });
                }
                if (this.streamDone) {
                    if (this.pending.length === 0)
                        return ok(undefined);
                    const text = this.pending;
                    this.pending = "";
                    return ok({ text, terminated: false });
                }
                // Race the in-flight read against abort: a held-open remote stream must
                // not hang readLine forever. On abort we cancel the underlying reader so
                // the pending read() rejects/settles and the remote stream is released.
                const chunk = await this.readChunk(signal);
                if (chunk === "aborted") {
                    await this.close(context);
                    return err(new FileError("aborted", "aborted", this.path));
                }
                if (chunk.done) {
                    this.streamDone = true;
                    this.pending += decodeUtf8(this.decoder, this.path);
                }
                else {
                    this.pending += decodeUtf8(this.decoder, this.path, chunk.value, true);
                }
            }
        }
        catch (error) {
            if (signal?.aborted)
                return err(new FileError("aborted", "aborted", this.path, errorValue(error)));
            return err(toFileError(error, this.path));
        }
    }
    /**
     * Read one chunk, but cancel the underlying reader if `signal` aborts while the
     * read is in flight (a hung remote stream must not block forever). Returns
     * `"aborted"` when the abort won the race.
     */
    async readChunk(signal) {
        if (signal === undefined)
            return await this.reader.read();
        let onAbort;
        const abortPromise = new Promise((resolve) => {
            onAbort = () => {
                void this.reader.cancel("aborted").catch(() => undefined);
                resolve("aborted");
            };
            signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
            return await Promise.race([this.reader.read(), abortPromise]);
        }
        finally {
            if (onAbort !== undefined)
                signal.removeEventListener("abort", onAbort);
        }
    }
    async close(_context) {
        if (this.closed)
            return;
        this.closed = true;
        try {
            await this.reader.cancel("closed");
        }
        catch { }
        try {
            this.reader.releaseLock();
        }
        catch { }
    }
}
//# sourceMappingURL=drive9-durable-file-system.js.map