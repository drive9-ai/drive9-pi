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
import type { FSLayer, FSLayerEntry } from "drive9";

export interface Drive9BaseFileInfo {
  name: string;
  size: number;
  isDir: boolean;
  mtime?: Date;
  mode?: number;
}

export interface Drive9BaseStat {
  size: number;
  isDir: boolean;
  revision: number;
  mtime?: Date;
  mode?: number;
}

export interface Drive9LayerFileSystemClient {
  getFSLayer(layerId: string): Promise<FSLayer>;
  diffFSLayer(layerId: string, maxSeq?: number): Promise<FSLayerEntry[]>;
  readFSLayerFile(layerId: string, path: string, maxSeq?: number): Promise<Uint8Array>;
  uploadFSLayerFile(
    layerId: string,
    path: string,
    data: Uint8Array,
    options?: { baseRevision?: number; mode?: number },
  ): Promise<FSLayerEntry>;
  upsertFSLayerEntry(
    layerId: string,
    request: {
      path: string;
      op: "mkdir" | "whiteout";
      kind: "file" | "dir" | "symlink";
      mode?: number;
      baseRevision?: number;
    },
  ): Promise<FSLayerEntry>;
  read(path: string): Promise<Uint8Array>;
  list(path: string): Promise<Drive9BaseFileInfo[]>;
  stat(path: string): Promise<Drive9BaseStat>;
}

export interface Drive9FileSystemOptions {
  client: Drive9LayerFileSystemClient;
  layerId: string;
  root: string;
  cwd?: string;
  tempRoot?: string;
  maxLayerEntries?: number;
  maxViewRetries?: number;
  viewTimeoutMs?: number;
}

interface LayerView {
  maxSeq: number;
  entries: Map<string, FSLayerEntry>;
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

function isMissing(value: unknown): boolean {
  return statusCode(value) === 404;
}

function toFileError(value: unknown, path?: string): FileError {
  if (value instanceof FileError) return value;
  const cause = errorValue(value);
  if (cause.name === "AbortError") return new FileError("aborted", cause.message, path, cause);
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
    case 404:
      return new FileError("not_found", cause.message, path, cause);
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

function entryKind(entry: FSLayerEntry): FileKind {
  if (entry.kind === "dir") return "directory";
  if (entry.kind === "symlink") return "symlink";
  return "file";
}

function modeKind(mode: number | undefined, isDir: boolean): FileKind {
  if (mode !== undefined && (mode & FILE_TYPE_MASK) === SYMLINK_TYPE) return "symlink";
  return isDir ? "directory" : "file";
}

function parsedTime(value: string | Date | undefined): number {
  if (value === undefined) return 0;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function layerInfo(entry: FSLayerEntry): FileInfo {
  return {
    name: posix.basename(entry.path),
    path: entry.path,
    kind: entryKind(entry),
    size: entry.size_bytes,
    mtimeMs: parsedTime(entry.updated_at),
  };
}

function baseInfo(path: string, info: Drive9BaseFileInfo | Drive9BaseStat): FileInfo {
  return {
    name: posix.basename(path),
    path,
    kind: modeKind(info.mode, info.isDir),
    size: info.size,
    mtimeMs: parsedTime(info.mtime),
  };
}

function unsupported(message: string, path?: string): Result<never, FileError> {
  return err(new FileError("not_supported", message, path));
}

export class Drive9FileSystem implements FileSystem {
  cwd: string;
  readonly root: string;
  readonly tempRoot: string;

  private readonly client: Drive9LayerFileSystemClient;
  private readonly layerId: string;
  private readonly maxLayerEntries: number;
  private readonly maxViewRetries: number;
  private readonly viewTimeoutMs: number;
  private readonly temporaryPaths = new Set<string>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: Drive9FileSystemOptions) {
    this.client = options.client;
    this.layerId = options.layerId.trim();
    if (this.layerId.length === 0 || this.layerId.includes("\0")) throw new TypeError("layerId must be non-empty");
    this.root = normalizeRoot(options.root, "root");
    this.cwd = normalizeRoot(options.cwd ?? this.root, "cwd");
    this.tempRoot = normalizeRoot(options.tempRoot ?? posix.join(this.root, ".drive9-pi-tmp"), "tempRoot");
    if (!isWithin(this.root, this.cwd)) throw new TypeError("cwd must be inside root");
    if (!isWithin(this.root, this.tempRoot)) throw new TypeError("tempRoot must be inside root");
    this.maxLayerEntries = options.maxLayerEntries ?? 10_000;
    if (!Number.isSafeInteger(this.maxLayerEntries) || this.maxLayerEntries < 1 || this.maxLayerEntries > 1_000_000) {
      throw new TypeError("maxLayerEntries must be between 1 and 1000000");
    }
    this.maxViewRetries = options.maxViewRetries ?? 3;
    if (!Number.isSafeInteger(this.maxViewRetries) || this.maxViewRetries < 1 || this.maxViewRetries > 10) {
      throw new TypeError("maxViewRetries must be between 1 and 10");
    }
    this.viewTimeoutMs = options.viewTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.viewTimeoutMs) || this.viewTimeoutMs < 1 || this.viewTimeoutMs > 300_000) {
      throw new TypeError("viewTimeoutMs must be between 1 and 300000");
    }
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
      return err(new FileError("invalid", "file is not valid UTF-8", this.addressedPath(path), errorValue(error)));
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
      const view = await this.layerView();
      await this.rejectSymlinkTraversal(addressed, view, true);
      const entry = this.visibleEntry(addressed, view);
      if (entry !== undefined) {
        if (entry.op === "whiteout") throw new FileError("not_found", "file is hidden by a layer whiteout", addressed);
        if (entry.path !== addressed) {
          if (entry.kind === "symlink") {
            throw new FileError("permission_denied", "symlink traversal is not supported", entry.path);
          }
          if (entry.kind !== "dir") throw new FileError("not_directory", "path ancestor is not a directory", entry.path);
          throw new FileError("not_found", "path is hidden by an opaque layer directory", addressed);
        }
        if (entry.kind === "dir") throw new FileError("is_directory", "path is a directory", addressed);
        if (entry.kind === "symlink") throw new FileError("not_supported", "symlink reads are not supported", addressed);
        if (entry.op !== "upsert") throw new FileError("not_supported", `layer operation ${entry.op} is not readable`, addressed);
        return Uint8Array.from(await this.client.readFSLayerFile(this.layerId, addressed, view.maxSeq));
      }
      const base = await this.client.stat(addressed);
      if (base.isDir) throw new FileError("is_directory", "path is a directory", addressed);
      if (modeKind(base.mode, base.isDir) === "symlink") {
        throw new FileError("not_supported", "symlink reads are not supported", addressed);
      }
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
      let view = await this.layerView();
      await this.rejectSymlinkTraversal(addressed, view, true);
      await this.ensureParents(addressed, view);
      view = await this.layerView();
      const existing = await this.infoAt(addressed, view, true);
      if (existing?.kind === "directory") throw new FileError("is_directory", "path is a directory", addressed);
      const baseRevision = await this.baseRevisionAt(addressed, view);
      await this.client.uploadFSLayerFile(
        this.layerId,
        addressed,
        typeof content === "string" ? Buffer.from(content, "utf8") : Uint8Array.from(content),
        { mode: 0o644, ...(baseRevision === undefined ? {} : { baseRevision }) },
      );
    });
  }

  async appendFile(path: string, _content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
    const abort = this.aborted<void>(abortSignal, this.safeAddress(path));
    if (abort !== undefined) return abort;
    try {
      const addressed = this.addressedPath(path);
      return unsupported("LayerFS append requires an atomic server append primitive", addressed);
    } catch (error) {
      return err(toFileError(error, this.safeAddress(path)));
    }
  }

  async renameFile(
    sourcePath: string,
    destinationPath: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const abort = this.aborted<void>(abortSignal, this.safeAddress(sourcePath));
    if (abort !== undefined) return abort;
    try {
      this.addressedPath(sourcePath);
      this.addressedPath(destinationPath);
    } catch (error) {
      return err(toFileError(error, this.safeAddress(sourcePath)));
    }
    return unsupported("LayerFS atomic rename requires a merged server rename contract", this.safeAddress(sourcePath));
  }

  async fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    return await this.operation(path, abortSignal, async () => {
      const addressed = this.addressedPath(path);
      const view = await this.layerView();
      await this.rejectSymlinkTraversal(addressed, view, false);
      const info = await this.infoAt(addressed, view, false);
      if (info === undefined) throw new FileError("not_found", "path does not exist", addressed);
      return info;
    });
  }

  async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    return await this.operation(path, abortSignal, async () => {
      const addressed = this.addressedPath(path);
      const view = await this.layerView();
      await this.rejectSymlinkTraversal(addressed, view, true);
      const directory = await this.infoAt(addressed, view, true);
      if (directory === undefined) throw new FileError("not_found", "directory does not exist", addressed);
      if (directory.kind !== "directory") throw new FileError("not_directory", "path is not a directory", addressed);
      return await this.listChildrenAt(addressed, view);
    });
  }

  async canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const info = await this.fileInfo(path, abortSignal);
    if (!info.ok) return info;
    if (info.value.kind === "symlink") {
      return unsupported("Drive9 SDK does not expose LayerFS symlink canonicalization", info.value.path);
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
      const recursive = options?.recursive ?? true;
      if (!recursive) {
        const view = await this.layerView();
        await this.rejectSymlinkTraversal(addressed, view, false);
        const parent = await this.infoAt(posix.dirname(addressed), view, true);
        if (parent === undefined) throw new FileError("not_found", "parent directory does not exist", posix.dirname(addressed));
        if (parent.kind !== "directory") throw new FileError("not_directory", "parent is not a directory", parent.path);
        await this.createDirectoryEntry(addressed, view);
        return;
      }
      let view = await this.layerView();
      for (const segment of this.relativeSegments(addressed)) {
        const current = posix.join(this.root, ...segment);
        const existing = await this.infoAt(current, view, true);
        if (existing !== undefined) {
          if (existing.kind !== "directory") throw new FileError("not_directory", "path component is not a directory", current);
          continue;
        }
        await this.createDirectoryEntry(current, view);
        view = await this.layerView();
      }
    });
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    let addressed: string;
    try {
      addressed = this.addressedPath(path);
    } catch (error) {
      return err(toFileError(error, this.safeAddress(path)));
    }
    const abort = this.aborted<void>(options?.abortSignal, addressed);
    if (abort !== undefined) return abort;
    if (options?.recursive === true) {
      return unsupported("LayerFS recursive remove requires an atomic server primitive", addressed);
    }
    return await this.mutate(path, options?.abortSignal, async () => {
      const target = this.addressedPath(path);
      if (target === this.root) throw new FileError("permission_denied", "workspace root cannot be removed", target);
      const view = await this.layerView();
      await this.rejectSymlinkTraversal(target, view, false);
      const info = await this.infoAt(target, view, false);
      if (info === undefined) {
        if (options?.force === true) return;
        throw new FileError("not_found", "path does not exist", target);
      }
      if (info.kind === "directory") {
        const children = await this.listChildrenAt(target, view);
        if (children.length > 0) throw new FileError("invalid", "directory is not empty", target);
      }
      const baseRevision = await this.baseRevisionAt(target, view);
      await this.client.upsertFSLayerEntry(this.layerId, {
        path: target,
        op: "whiteout",
        kind: info.kind === "directory" ? "dir" : info.kind,
        ...(baseRevision === undefined ? {} : { baseRevision }),
      });
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
    const paths = [...this.temporaryPaths].sort((left, right) => right.length - left.length);
    this.temporaryPaths.clear();
    for (const path of paths) {
      try {
        const result = await this.remove(path, { force: true });
        if (!result.ok) continue;
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

  private async layerView(): Promise<LayerView> {
    const assembly = this.assembleLayerView();
    return await new Promise<LayerView>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new FileError("unknown", `LayerFS view exceeded ${this.viewTimeoutMs}ms`, this.root));
      }, this.viewTimeoutMs);
      void assembly.then(
        (view) => {
          clearTimeout(timeout);
          resolve(view);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  private async assembleLayerView(): Promise<LayerView> {
    for (let attempt = 0; attempt < this.maxViewRetries; attempt += 1) {
      const before = await this.client.getFSLayer(this.layerId);
      if (posix.normalize(before.base_root_path) !== this.root) {
        throw new FileError("invalid", "LayerFS base root does not match Drive9FileSystem root", this.root);
      }
      const entries = await this.client.diffFSLayer(this.layerId, before.durable_seq);
      if (entries.length > this.maxLayerEntries) {
        throw new FileError(
          "not_supported",
          `LayerFS view exceeds maxLayerEntries=${this.maxLayerEntries}`,
          this.root,
        );
      }
      const after = await this.client.getFSLayer(this.layerId);
      if (after.durable_seq !== before.durable_seq) continue;
      const byPath = new Map<string, FSLayerEntry>();
      for (const entry of entries) {
        if (entry.path !== posix.normalize(entry.path) || !isWithin(this.root, entry.path)) {
          throw new FileError("unknown", "Drive9 returned a layer entry outside the configured root", entry.path);
        }
        byPath.set(entry.path, entry);
      }
      return { maxSeq: before.durable_seq, entries: byPath };
    }
    throw new FileError("unknown", "LayerFS changed while assembling a stable view", this.root);
  }

  private visibleEntry(path: string, view: LayerView): FSLayerEntry | undefined {
    const exact = view.entries.get(path);
    let opaqueDirectory: FSLayerEntry | undefined;
    for (const ancestor of this.ancestors(path, false)) {
      const entry = view.entries.get(ancestor);
      if (entry === undefined) continue;
      if (entry.op === "whiteout" || entry.kind !== "dir") return entry;
      if (exact === undefined || exact.entry_seq <= entry.entry_seq) opaqueDirectory = entry;
    }
    return opaqueDirectory ?? exact;
  }

  private async infoAt(path: string, view: LayerView, rejectWhiteout: boolean): Promise<FileInfo | undefined> {
    const entry = this.visibleEntry(path, view);
    if (entry !== undefined) {
      if (entry.op === "whiteout") {
        if (rejectWhiteout) throw new FileError("not_found", "path is hidden by a layer whiteout", path);
        return undefined;
      }
      if (entry.path !== path) {
        if (entry.kind === "symlink") throw new FileError("permission_denied", "symlink traversal is not supported", entry.path);
        if (entry.kind !== "dir") throw new FileError("not_directory", "path ancestor is not a directory", entry.path);
        return undefined;
      }
      return this.materializedLayerInfo(entry);
    }
    try {
      return baseInfo(path, await this.client.stat(path));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private async listChildrenAt(path: string, view: LayerView): Promise<FileInfo[]> {
    const children = new Map<string, FileInfo>();
    const directoryEntry = view.entries.get(path);
    if (directoryEntry === undefined) {
      try {
        for (const info of await this.client.list(path)) {
          if (info.name.includes("/") || info.name.includes("\\") || info.name === "." || info.name === "..") {
            throw new FileError("unknown", "Drive9 returned an invalid directory child", path);
          }
          const childPath = posix.join(path, info.name);
          children.set(info.name, baseInfo(childPath, info));
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }

    for (const entry of view.entries.values()) {
      if (posix.dirname(entry.path) !== path) continue;
      if (directoryEntry !== undefined && entry.entry_seq <= directoryEntry.entry_seq) continue;
      const name = posix.basename(entry.path);
      if (entry.op === "whiteout") children.delete(name);
      else children.set(name, this.materializedLayerInfo(entry));
    }
    return [...children.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  private async rejectSymlinkTraversal(path: string, view: LayerView, includeLeaf: boolean): Promise<void> {
    const ancestors = this.ancestors(path, includeLeaf);
    for (const ancestor of ancestors) {
      const info = await this.infoAt(ancestor, view, false);
      if (info?.kind === "symlink") {
        throw new FileError("permission_denied", "symlink traversal is not supported", ancestor);
      }
    }
  }

  private ancestors(path: string, includeLeaf: boolean): string[] {
    if (path === this.root) return includeLeaf ? [this.root] : [];
    const parts = posix.relative(this.root, path).split("/");
    const length = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
    const values: string[] = [];
    for (let index = 1; index <= length; index += 1) values.push(posix.join(this.root, ...parts.slice(0, index)));
    return values;
  }

  private relativeSegments(path: string): string[][] {
    const parts = posix.relative(this.root, path).split("/").filter((part) => part.length > 0);
    return parts.map((_part, index) => parts.slice(0, index + 1));
  }

  private async ensureParents(path: string, initialView: LayerView): Promise<void> {
    let view = initialView;
    for (const segment of this.relativeSegments(posix.dirname(path))) {
      const current = posix.join(this.root, ...segment);
      const info = await this.infoAt(current, view, false);
      if (info !== undefined) {
        if (info.kind !== "directory") throw new FileError("not_directory", "parent path is not a directory", current);
        continue;
      }
      await this.createDirectoryEntry(current, view);
      view = await this.layerView();
    }
  }

  private async createDirectoryEntry(path: string, view: LayerView): Promise<void> {
    const existing = await this.infoAt(path, view, false);
    if (existing !== undefined) {
      if (existing.kind !== "directory") throw new FileError("invalid", "path already exists and is not a directory", path);
      return;
    }
    const baseRevision = await this.baseRevisionAt(path, view);
    await this.client.upsertFSLayerEntry(this.layerId, {
      path,
      op: "mkdir",
      kind: "dir",
      mode: 0o755,
      ...(baseRevision === undefined ? {} : { baseRevision }),
    });
  }

  private materializedLayerInfo(entry: FSLayerEntry): FileInfo {
    if (entry.op !== "upsert" && entry.op !== "mkdir" && entry.op !== "symlink") {
      throw new FileError("not_supported", `LayerFS operation ${entry.op} is not supported by the merged view`, entry.path);
    }
    if (entry.op === "mkdir" && entry.kind !== "dir") {
      throw new FileError("unknown", "Drive9 returned a non-directory mkdir entry", entry.path);
    }
    if (entry.op === "symlink" && entry.kind !== "symlink") {
      throw new FileError("unknown", "Drive9 returned a non-symlink symlink entry", entry.path);
    }
    return layerInfo(entry);
  }

  private async baseRevisionAt(path: string, view: LayerView): Promise<number | undefined> {
    const exact = view.entries.get(path);
    if (exact !== undefined && Number.isSafeInteger(exact.base_revision) && exact.base_revision > 0) {
      return exact.base_revision;
    }
    const visible = this.visibleEntry(path, view);
    if (visible !== undefined) return undefined;
    try {
      const revision = (await this.client.stat(path)).revision;
      return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
    } catch (error) {
      if (isMissing(error)) return undefined;
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
      this.temporaryPaths.add(path);
      return ok(path);
    }
    return err(new FileError("unknown", "could not allocate a unique temporary path", this.tempRoot));
  }
}
