import type { Context } from "@earendil-works/chord";
import { FileError, type FileInfo, type FileSystem, type Result, type TextLineReader } from "@earendil-works/pi-durable/env";
export interface Drive9FileEntry {
    name: string;
    size: number;
    isDir: boolean;
    mtime?: Date;
    mode?: number;
}
export interface Drive9Stat {
    size: number;
    isDir: boolean;
    revision: number;
    mtime?: Date;
    mode?: number;
}
export interface Drive9DurableFileSystemClient {
    read(path: string): Promise<Uint8Array>;
    readStream?(path: string): Promise<ReadableStream<Uint8Array>>;
    write(path: string, data: Uint8Array): Promise<void>;
    createFile?(path: string): Promise<number>;
    append(path: string, data: Uint8Array): Promise<void>;
    list(path: string): Promise<Drive9FileEntry[]>;
    stat(path: string): Promise<Drive9Stat>;
    rename(sourcePath: string, destinationPath: string): Promise<void>;
    mkdir(path: string, mode?: number): Promise<void>;
    deleteFile(path: string): Promise<void>;
    deleteDir(path: string): Promise<void>;
    removeAll(path: string): Promise<void>;
}
export interface Drive9DurableFileSystemOptions {
    client: Drive9DurableFileSystemClient;
    root: string;
    cwd?: string;
    tempRoot?: string;
    /**
     * Pi 1.0 filesystem namespace id. Supply a stable
     * `drive9:<server-fingerprint>:<tenant>:<root>` from the caller so equal
     * namespaces share an id and forks differ. Defaults to `drive9:<root>`.
     */
    id?: string;
}
export declare class Drive9DurableFileSystem implements FileSystem {
    /**
     * Pi 1.0 namespace identity: equal ids see the same files at the same paths.
     * Derived from the Drive9 namespace (server/tenant/root), NOT the JS instance,
     * so two adapters onto the same namespace share an id and a forked workspace
     * gets a different one. Pi uses this to serialize file mutations.
     */
    readonly id: string;
    readonly root: string;
    readonly tempRoot: string;
    private readonly client;
    private currentWorkingDirectory;
    private readonly temporaryPaths;
    private mutationTail;
    constructor(options: Drive9DurableFileSystemOptions);
    get cwd(): string;
    set cwd(value: string);
    absolutePath(path: string, context: Context): Promise<Result<string, FileError>>;
    joinPath(parts: string[], context: Context): Promise<Result<string, FileError>>;
    readTextFile(path: string, context: Context): Promise<Result<string, FileError>>;
    readTextLines(path: string, options: {
        maxLines?: number;
    } | undefined, context: Context): Promise<Result<string[], FileError>>;
    /**
     * Stream a file line-by-line from Drive9. Incremental UTF-8 decode; preserves
     * an unterminated final line; cancels the remote reader on close/abort. Does
     * NOT read the whole file then split. Requires the SDK `readStream`; without
     * it we fail closed with `not_supported` rather than silently buffering.
     */
    openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>>;
    readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>>;
    writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
    appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
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
    truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>>;
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
    flushFile(path: string, context: Context): Promise<Result<void, FileError>>;
    renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>>;
    fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>>;
    listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>>;
    canonicalPath(path: string, context: Context): Promise<Result<string, FileError>>;
    exists(path: string, context: Context): Promise<Result<boolean, FileError>>;
    createDir(path: string, options: {
        recursive?: boolean;
    } | undefined, context: Context): Promise<Result<void, FileError>>;
    remove(path: string, options: {
        recursive?: boolean;
        force?: boolean;
    } | undefined, context: Context): Promise<Result<void, FileError>>;
    createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>>;
    createTempFile(options: {
        prefix?: string;
        suffix?: string;
    } | undefined, context: Context): Promise<Result<string, FileError>>;
    cleanup(context: Context): Promise<void>;
    private addressedPath;
    private safeAddress;
    private aborted;
    private operation;
    private mutate;
    private assertReadableFile;
    private readTextLinesFromStream;
    private statInfo;
    private optionalInfo;
    private pathSegments;
    private ensureParents;
    private ensureDirectory;
    private createTemporaryPath;
}
//# sourceMappingURL=drive9-durable-file-system.d.ts.map