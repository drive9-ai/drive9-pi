import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  err,
  FileError,
  type FileInfo,
  type FileKind,
  type FileSystem,
  ok,
  type Result,
} from "@earendil-works/pi-agent-core";

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
  write(path: string, data: Uint8Array): Promise<void>;
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

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const FILE_TYPE_MASK = 0o170000;
const SYMLINK_TYPE = 0o120000;

function isStatusError(error: unknown): error is { statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

function statusCode(error: unknown): number | undefined {
  if (isStatusError(error)) return error.statusCode;
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function errorValue(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : String(value));
}

function errorMessage(value: unknown): string {
  return errorValue(value).message.toLowerCase();
}

function isMissing(value: unknown): boolean {
  return statusCode(value) === 404 || errorMessage(value).includes("not found");
}

function toFileError(value: unknown, path?: string): FileError {
  if (value instanceof FileError) return value;
  const cause = errorValue(value);
  const message = cause.message.toLowerCase();
  if (cause.name === "AbortError") return new FileError("aborted", cause.message, path, cause);
  if (isMissing(value)) return new FileError("not_found", cause.message, path, cause);
  if (message.includes("not a directory")) return new FileError("not_directory", cause.message, path, cause);
  if (message.includes("is a directory")) return new FileError("is_directory", cause.message, path, cause);
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

function normalizeRoot(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    !posix.isAbsolute(value)
  ) {
    throw new TypeError(`${label} must be an absolute POSIX path`);
  }
  const normalized = posix.normalize(value);
  if (normalized === "/") throw new TypeError(`${label} cannot be the tenant root`);
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function validateComponent(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new FileError("invalid", `${label} must be a single path component`);
  }
  return value;
}

function fileKind(mode: number | undefined, isDir: boolean): FileKind {
  if (mode !== undefined && (mode & FILE_TYPE_MASK) === SYMLINK_TYPE) return "symlink";
  return isDir ? "directory" : "file";
}

function modificationTime(value: Date | undefined): number {
  const time = value?.getTime() ?? 0;
  return Number.isFinite(time) ? time : 0;
}

function materializeInfo(path: string, info: Drive9FileEntry | Drive9Stat): FileInfo {
  return {
    name: posix.basename(path),
    path,
    kind: fileKind(info.mode, info.isDir),
    size: info.size,
    mtimeMs: modificationTime(info.mtime),
  };
}

export class Drive9FileSystem implements FileSystem {
  cwd: string;
  readonly root: string;
  readonly tempRoot: string;

  private readonly client: Drive9FileSystemClient;
  private readonly temporaryPaths = new Map<string, boolean>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: Drive9FileSystemOptions) {
    this.client = options.client;
    this.root = normalizeRoot(options.root, "root");
    this.cwd = normalizeRoot(options.cwd ?? this.root, "cwd");
    this.tempRoot = normalizeRoot(options.tempRoot ?? posix.join(this.root, ".drive9-pi-tmp"), "tempRoot");
    if (!isWithin(this.root, this.cwd)) throw new TypeError("cwd must be inside root");
    if (!isWithin(this.root, this.tempRoot)) throw new TypeError("tempRoot must be inside root");
  }

  async absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return await this.operation(path, abortSignal, async () => this.addressedPath(path));
  }

  async joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return await this.operation(undefined, abortSignal, async () => {
      if (!Array.isArray(parts) || parts.some((part) => typeof part !== "string" || part.includes("\0"))) {
        throw new FileError("invalid", "path parts must be strings without null bytes");
      }
      return this.addressedPath(posix.join(...parts));
    });
  }

  async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const result = await this.readBinaryFile(path, abortSignal);
    if (!result.ok) return result;
    try {
      return ok(TEXT_DECODER.decode(result.value));
    } catch (error) {
      return err(new FileError("invalid", "file is not valid UTF-8", this.safeAddress(path), errorValue(error)));
    }
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>> {
    if (options?.maxLines !== undefined && (!Number.isSafeInteger(options.maxLines) || options.maxLines < 0)) {
      return err(new FileError("invalid", "maxLines must be a non-negative integer", this.safeAddress(path)));
    }
    const result = await this.readTextFile(path, options?.abortSignal);
    if (!result.ok) return result;
    const lines = result.value.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    return await this.operation(path, abortSignal, async () => {
      const addressed = this.addressedPath(path);
      const info = await this.statInfo(addressed);
      if (info.kind === "directory") throw new FileError("is_directory", "path is a directory", addressed);
      if (info.kind === "symlink") throw new FileError("not_supported", "symlink reads are not supported", addressed);
      return Uint8Array.from(await this.client.read(addressed));
    });
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    return await this.mutate(path, abortSignal, async () => {
      const addressed = this.addressedPath(path);
      if (addressed === this.root) throw new FileError("permission_denied", "workspace root cannot be overwritten", addressed);
      await this.ensureParents(addressed);
      const existing = await this.optionalInfo(addressed);
      if (existing?.kind === "directory") throw new FileError("is_directory", "path is a directory", addressed);
      if (existing?.kind === "symlink") throw new FileError("not_supported", "symlink writes are not supported", addressed);
      const data = typeof content === "string" ? Buffer.from(content, "utf8") : Uint8Array.from(content);
      await this.client.write(addressed, data);
    });
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    return await this.mutate(path, abortSignal, async () => {
      const addressed = this.addressedPath(path);
      if (addressed === this.root) throw new FileError("permission_denied", "workspace root cannot be appended", addressed);
      await this.ensureParents(addressed);
      const existing = await this.optionalInfo(addressed);
      if (existing?.kind === "directory") throw new FileError("is_directory", "path is a directory", addressed);
      if (existing?.kind === "symlink") throw new FileError("not_supported", "symlink appends are not supported", addressed);
      const data = typeof content === "string" ? Buffer.from(content, "utf8") : Uint8Array.from(content);
      await this.client.append(addressed, data);
    });
  }

  async renameFile(
    sourcePath: string,
    destinationPath: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    return await this.mutate(sourcePath, abortSignal, async () => {
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

  async fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    return await this.operation(path, abortSignal, async () => await this.statInfo(this.addressedPath(path)));
  }

  async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    return await this.operation(path, abortSignal, async () => {
      const addressed = this.addressedPath(path);
      const directory = await this.statInfo(addressed);
      if (directory.kind !== "directory") throw new FileError("not_directory", "path is not a directory", addressed);
      const children = (await this.client.list(addressed)).map((entry) => {
        if (
          typeof entry.name !== "string" ||
          entry.name.length === 0 ||
          entry.name === "." ||
          entry.name === ".." ||
          entry.name.includes("/") ||
          entry.name.includes("\\") ||
          entry.name.includes("\0")
        ) {
          throw new FileError("unknown", "Drive9 returned an invalid directory child", addressed);
        }
        return materializeInfo(posix.join(addressed, entry.name), entry);
      });
      return children.sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  async canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const info = await this.fileInfo(path, abortSignal);
    if (!info.ok) return info;
    if (info.value.kind === "symlink") {
      return err(new FileError("not_supported", "Drive9 SDK does not expose symlink canonicalization", info.value.path));
    }
    return ok(info.value.path);
  }

  async exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, abortSignal);
    if (info.ok) return ok(true);
    return info.error.code === "not_found" ? ok(false) : info;
  }

  async createDir(
    path: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    return await this.mutate(path, options?.abortSignal, async () => {
      const addressed = this.addressedPath(path);
      if (addressed === this.root) return;
      if (options?.recursive ?? true) {
        for (const current of this.pathSegments(addressed)) await this.ensureDirectory(current);
        return;
      }
      const parent = await this.statInfo(posix.dirname(addressed));
      if (parent.kind !== "directory") throw new FileError("not_directory", "parent is not a directory", parent.path);
      await this.ensureDirectory(addressed);
    });
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    return await this.mutate(path, options?.abortSignal, async () => {
      const addressed = this.addressedPath(path);
      if (addressed === this.root) throw new FileError("permission_denied", "workspace root cannot be removed", addressed);
      const info = await this.optionalInfo(addressed);
      if (info === undefined) {
        if (options?.force === true) return;
        throw new FileError("not_found", "path does not exist", addressed);
      }
      if (options?.recursive === true) {
        await this.client.removeAll(addressed);
        return;
      }
      if (info.kind === "directory") {
        const children = await this.client.list(addressed);
        if (children.length > 0) throw new FileError("invalid", "directory is not empty", addressed);
        await this.client.deleteDir(addressed);
        return;
      }
      await this.client.deleteFile(addressed);
    });
  }

  async createTempDir(prefix = "tmp-", abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    try {
      return await this.createTemporaryPath(validateComponent(prefix, "prefix"), "", true, abortSignal);
    } catch (error) {
      return err(toFileError(error, this.tempRoot));
    }
  }

  async createTempFile(
    options?: { prefix?: string; suffix?: string; abortSignal?: AbortSignal },
  ): Promise<Result<string, FileError>> {
    let prefix: string;
    let suffix: string;
    try {
      prefix = validateComponent(options?.prefix ?? "", "prefix");
      suffix = validateComponent(options?.suffix ?? "", "suffix");
    } catch (error) {
      return err(toFileError(error, this.tempRoot));
    }
    return await this.createTemporaryPath(prefix, suffix, false, options?.abortSignal);
  }

  async cleanup(): Promise<void> {
    const paths = [...this.temporaryPaths.entries()].sort(([left], [right]) => right.length - left.length);
    this.temporaryPaths.clear();
    for (const [path, directory] of paths) {
      try {
        await this.remove(path, { recursive: directory, force: true });
      } catch {}
    }
  }

  private addressedPath(path: string): string {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0") || path.includes("\\")) {
      throw new FileError("invalid", "path must be a non-empty POSIX path");
    }
    const addressed = posix.normalize(posix.isAbsolute(path) ? path : posix.resolve(this.cwd, path));
    if (!isWithin(this.root, addressed)) throw new FileError("permission_denied", "path escapes Drive9 root", addressed);
    return addressed;
  }

  private safeAddress(path: string): string | undefined {
    try {
      return this.addressedPath(path);
    } catch {
      return undefined;
    }
  }

  private aborted<T>(signal: AbortSignal | undefined, path?: string): Result<T, FileError> | undefined {
    return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
  }

  private async operation<T>(
    path: string | undefined,
    signal: AbortSignal | undefined,
    operation: () => Promise<T> | T,
  ): Promise<Result<T, FileError>> {
    const abort = this.aborted<T>(signal, path === undefined ? undefined : this.safeAddress(path));
    if (abort !== undefined) return abort;
    try {
      return ok(await operation());
    } catch (error) {
      return err(toFileError(error, path === undefined ? undefined : this.safeAddress(path)));
    }
  }

  private async mutate(
    path: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<void>,
  ): Promise<Result<void, FileError>> {
    const run = async (): Promise<Result<void, FileError>> => await this.operation(path, signal, operation);
    const running = this.mutationTail.then(run, run);
    this.mutationTail = running.then(
      () => undefined,
      () => undefined,
    );
    return await running;
  }

  private async statInfo(path: string): Promise<FileInfo> {
    return materializeInfo(path, await this.client.stat(path));
  }

  private async optionalInfo(path: string): Promise<FileInfo | undefined> {
    try {
      return await this.statInfo(path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private pathSegments(path: string): string[] {
    const parts = posix.relative(this.root, path).split("/").filter((part) => part.length > 0);
    return parts.map((_part, index) => posix.join(this.root, ...parts.slice(0, index + 1)));
  }

  private async ensureParents(path: string): Promise<void> {
    for (const parent of this.pathSegments(posix.dirname(path))) await this.ensureDirectory(parent);
  }

  private async ensureDirectory(path: string): Promise<void> {
    const existing = await this.optionalInfo(path);
    if (existing !== undefined) {
      if (existing.kind !== "directory") throw new FileError("not_directory", "path component is not a directory", path);
      return;
    }
    try {
      await this.client.mkdir(path, 0o755);
    } catch (error) {
      const concurrent = await this.optionalInfo(path);
      if (concurrent?.kind === "directory") return;
      throw error;
    }
  }

  private async createTemporaryPath(
    prefix: string,
    suffix: string,
    directory: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Result<string, FileError>> {
    const tempDirectory = await this.createDir(this.tempRoot, {
      recursive: true,
      ...(signal === undefined ? {} : { abortSignal: signal }),
    });
    if (!tempDirectory.ok) return tempDirectory;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const path = posix.join(this.tempRoot, `${prefix}${randomUUID()}${suffix}`);
      const exists = await this.exists(path, signal);
      if (!exists.ok) return exists;
      if (exists.value) continue;
      const created = directory
        ? await this.createDir(path, {
            recursive: false,
            ...(signal === undefined ? {} : { abortSignal: signal }),
          })
        : await this.writeFile(path, new Uint8Array(), signal);
      if (!created.ok) return created;
      this.temporaryPaths.set(path, directory);
      return ok(path);
    }
    return err(new FileError("unknown", "could not allocate a unique temporary path", this.tempRoot));
  }
}
