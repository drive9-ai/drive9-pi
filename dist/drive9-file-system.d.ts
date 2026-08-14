import { FileError, type FileInfo, type FileSystem, type Result } from "@earendil-works/pi-agent-core";
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
export interface Drive9FileSystemClient {
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
export interface Drive9FileSystemOptions {
    client: Drive9FileSystemClient;
    root: string;
    cwd?: string;
    tempRoot?: string;
}
export declare class Drive9FileSystem implements FileSystem {
    readonly root: string;
    readonly tempRoot: string;
    private readonly client;
    private currentWorkingDirectory;
    private readonly temporaryPaths;
    private mutationTail;
    constructor(options: Drive9FileSystemOptions);
    get cwd(): string;
    set cwd(value: string);
    absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
    joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
    readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
    readTextLines(path: string, options?: {
        maxLines?: number;
        abortSignal?: AbortSignal;
    }): Promise<Result<string[], FileError>>;
    readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>>;
    writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
    appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
    renameFile(sourcePath: string, destinationPath: string, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
    fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>>;
    listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>>;
    canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
    exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>>;
    createDir(path: string, options?: {
        recursive?: boolean;
        abortSignal?: AbortSignal;
    }): Promise<Result<void, FileError>>;
    remove(path: string, options?: {
        recursive?: boolean;
        force?: boolean;
        abortSignal?: AbortSignal;
    }): Promise<Result<void, FileError>>;
    createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
    createTempFile(options?: {
        prefix?: string;
        suffix?: string;
        abortSignal?: AbortSignal;
    }): Promise<Result<string, FileError>>;
    cleanup(): Promise<void>;
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
//# sourceMappingURL=drive9-file-system.d.ts.map