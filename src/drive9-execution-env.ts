import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type ExecutionEnv,
  ExecutionError,
  err,
  FileError,
  type FileInfo,
  ok,
  type Result,
  type ShellExecOptions,
  toError,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

export interface Drive9ExecutionEnvOptions {
  workspaceRoot: string;
  cwd?: string;
  tempRoot?: string;
  env?: Record<string, string>;
}

interface GuardedPath {
  addressed: string;
  canonical: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function validateAbsoluteOption(name: string, value: string): string {
  if (!isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  if (value.includes("\0")) throw new TypeError(`${name} must not contain a null byte`);
  return resolve(value);
}

function ensureDirectory(path: string, name: string): void {
  const info = statSync(path);
  if (!info.isDirectory()) throw new TypeError(`${name} must address a directory`);
}

function nearestExistingSync(path: string): string {
  let candidate = path;
  while (true) {
    try {
      lstatSync(candidate);
      return candidate;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function toFileError(error: unknown, fallbackPath?: string): FileError {
  if (error instanceof FileError) return error;
  const cause = toError(error);
  const nodeError = isNodeError(error) ? error : undefined;
  const path = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath;
  switch (nodeError?.code) {
    case "ABORT_ERR":
      return new FileError("aborted", cause.message, path, cause);
    case "ENOENT":
      return new FileError("not_found", cause.message, path, cause);
    case "EACCES":
    case "EPERM":
      return new FileError("permission_denied", cause.message, path, cause);
    case "ENOTDIR":
      return new FileError("not_directory", cause.message, path, cause);
    case "EISDIR":
      return new FileError("is_directory", cause.message, path, cause);
    case "EINVAL":
    case "EEXIST":
    case "ELOOP":
    case "ENAMETOOLONG":
    case "ENOTEMPTY":
      return new FileError("invalid", cause.message, path, cause);
    case "EXDEV":
    case "ENOSYS":
    case "ENOTSUP":
    case "EOPNOTSUPP":
      return new FileError("not_supported", cause.message, path, cause);
    default:
      return new FileError("unknown", cause.message, path, cause);
  }
}

function aborted<T>(signal: AbortSignal | undefined, path?: string): Result<T, FileError> | undefined {
  return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

function validateTempName(value: unknown, field: string): Result<string, FileError> {
  if (
    typeof value !== "string" ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    return err(new FileError("invalid", `${field} must be a single path component`));
  }
  return ok(value);
}

export class Drive9ExecutionEnv implements ExecutionEnv {
  cwd: string;
  readonly workspaceRoot: string;
  readonly tempRoot: string;

  private readonly canonicalWorkspaceRoot: string;
  private readonly privateTempRoot: string;
  private readonly nodeEnv: NodeExecutionEnv;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: Drive9ExecutionEnvOptions) {
    this.workspaceRoot = validateAbsoluteOption("workspaceRoot", options.workspaceRoot);
    ensureDirectory(this.workspaceRoot, "workspaceRoot");
    this.canonicalWorkspaceRoot = realpathSync(this.workspaceRoot);

    this.cwd = validateAbsoluteOption("cwd", options.cwd ?? this.workspaceRoot);
    this.assertLexicalPath(this.cwd, "cwd");
    const canonicalCwd = realpathSync(this.cwd);
    this.assertCanonicalPath(canonicalCwd, this.cwd);
    ensureDirectory(canonicalCwd, "cwd");

    this.tempRoot = validateAbsoluteOption("tempRoot", options.tempRoot ?? join(this.workspaceRoot, ".drive9-pi-tmp"));
    this.assertLexicalPath(this.tempRoot, "tempRoot");
    const existingTempAncestor = realpathSync(nearestExistingSync(this.tempRoot));
    this.assertCanonicalPath(existingTempAncestor, this.tempRoot);
    mkdirSync(this.tempRoot, { recursive: true, mode: 0o700 });
    const canonicalTempRoot = realpathSync(this.tempRoot);
    this.assertCanonicalPath(canonicalTempRoot, this.tempRoot);
    ensureDirectory(canonicalTempRoot, "tempRoot");
    this.privateTempRoot = mkdtempSync(join(canonicalTempRoot, "env-"));

    const tempEnv = {
      TMPDIR: this.privateTempRoot,
      TMP: this.privateTempRoot,
      TEMP: this.privateTempRoot,
    };
    this.nodeEnv = new NodeExecutionEnv({ cwd: this.cwd, shellEnv: { ...tempEnv, ...options.env } });
  }

  async absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return await this.fileOperation(path, async () => {
      const addressed = this.addressedPath(path);
      if (!addressed.ok) return addressed;
      const abort = aborted<string>(abortSignal, addressed.value);
      return abort ?? ok(addressed.value);
    });
  }

  async joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return await this.fileOperation(undefined, async () => {
      if (!Array.isArray(parts) || parts.some((part) => typeof part !== "string" || part.includes("\0"))) {
        return err(new FileError("invalid", "path parts must be strings without null bytes"));
      }
      return await this.absolutePath(join(...parts), abortSignal);
    });
  }

  async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return await this.followedOperation(path, abortSignal, async (addressed) => {
      return await this.nodeEnv.readTextFile(addressed, abortSignal);
    });
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>> {
    return await this.followedOperation(path, options?.abortSignal, async (addressed) => {
      return await this.nodeEnv.readTextLines(addressed, options);
    });
  }

  async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    return await this.followedOperation(path, abortSignal, async (addressed) => {
      return await this.nodeEnv.readBinaryFile(addressed, abortSignal);
    });
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    return await this.mutate(path, abortSignal, true, async (addressed) => {
      return await this.nodeEnv.writeFile(addressed, content, abortSignal);
    });
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    return await this.mutate(path, abortSignal, true, async (addressed) => {
      const result = await this.nodeEnv.appendFile(addressed, content);
      return aborted<void>(abortSignal, addressed) ?? result;
    });
  }

  async renameFile(
    sourcePath: string,
    destinationPath: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    return await this.enqueueMutation(async () => {
      return await this.fileOperation(destinationPath, async () => {
        const source = this.addressedPath(sourcePath);
        if (!source.ok) return source;
        const destination = this.addressedPath(destinationPath);
        if (!destination.ok) return destination;
        const abort = aborted<void>(abortSignal, destination.value);
        if (abort) return abort;
        if (source.value === this.workspaceRoot || destination.value === this.workspaceRoot) {
          return err(new FileError("permission_denied", "workspace root cannot be renamed", source.value));
        }
        const sourceParent = await this.guardExistingPath(dirname(source.value));
        if (!sourceParent.ok) return sourceParent;
        const destinationParent = await this.guardExistingPath(dirname(destination.value));
        if (!destinationParent.ok) return destinationParent;
        const [sourceInfo, destinationInfo] = await Promise.all([
          stat(sourceParent.value.canonical),
          stat(destinationParent.value.canonical),
        ]);
        if (sourceInfo.dev !== destinationInfo.dev) {
          return err(new FileError("not_supported", "rename across filesystems is not supported", source.value));
        }
        await rename(source.value, destination.value);
        return aborted<void>(abortSignal, destination.value) ?? ok(undefined);
      });
    });
  }

  async fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    return await this.parentGuardedOperation(path, abortSignal, async (addressed) => {
      return await this.nodeEnv.fileInfo(addressed);
    });
  }

  async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    return await this.followedOperation(path, abortSignal, async (addressed) => {
      return await this.nodeEnv.listDir(addressed, abortSignal);
    });
  }

  async canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return await this.fileOperation(path, async () => {
      const guarded = await this.guardExistingPathInput(path, abortSignal);
      return guarded.ok ? ok(guarded.value.canonical) : guarded;
    });
  }

  async exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, abortSignal);
    if (info.ok) return ok(true);
    return info.error.code === "not_found" ? ok(false) : err(info.error);
  }

  async createDir(
    path: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    return await this.mutate(path, options?.abortSignal, true, async (addressed) => {
      await mkdir(addressed, { recursive: options?.recursive ?? true });
      return aborted<void>(options?.abortSignal, addressed) ?? ok(undefined);
    });
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    return await this.enqueueMutation(async () => {
      return await this.fileOperation(path, async () => {
        const addressed = this.addressedPath(path);
        if (!addressed.ok) return addressed;
        const abort = aborted<void>(options?.abortSignal, addressed.value);
        if (abort) return abort;
        if (addressed.value === this.workspaceRoot) {
          return err(new FileError("permission_denied", "workspace root cannot be removed", addressed.value));
        }
        const parent = await this.guardExistingPath(dirname(addressed.value));
        if (!parent.ok) return parent;
        await rm(addressed.value, {
          recursive: options?.recursive ?? false,
          force: options?.force ?? false,
        });
        return aborted<void>(options?.abortSignal, addressed.value) ?? ok(undefined);
      });
    });
  }

  async createTempDir(prefix: string = "tmp-", abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return await this.enqueueMutation(async () => {
      return await this.fileOperation(this.privateTempRoot, async () => {
        const validPrefix = validateTempName(prefix, "prefix");
        if (!validPrefix.ok) return validPrefix;
        const abort = aborted<string>(abortSignal, this.privateTempRoot);
        if (abort) return abort;
        const path = await mkdtemp(join(this.privateTempRoot, validPrefix.value || "tmp-"));
        return aborted<string>(abortSignal, path) ?? ok(path);
      });
    });
  }

  async createTempFile(options?: {
    prefix?: string;
    suffix?: string;
    abortSignal?: AbortSignal;
  }): Promise<Result<string, FileError>> {
    return await this.enqueueMutation(async () => {
      return await this.fileOperation(this.privateTempRoot, async () => {
        const prefix = validateTempName(options?.prefix ?? "", "prefix");
        if (!prefix.ok) return prefix;
        const suffix = validateTempName(options?.suffix ?? "", "suffix");
        if (!suffix.ok) return suffix;
        const abort = aborted<string>(options?.abortSignal, this.privateTempRoot);
        if (abort) return abort;
        const path = join(this.privateTempRoot, `${prefix.value}${randomUUID()}${suffix.value}`);
        await writeFile(path, "", { flag: "wx", mode: 0o600, signal: options?.abortSignal });
        return ok(path);
      });
    });
  }

  async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    try {
      if (options?.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
      const selectedCwd = options?.cwd ?? this.cwd;
      const guarded = await this.guardExistingPathInput(selectedCwd, options?.abortSignal);
      if (!guarded.ok) {
        return err(new ExecutionError("spawn_error", guarded.error.message, guarded.error));
      }
      const cwdInfo = await lstat(guarded.value.canonical);
      if (!cwdInfo.isDirectory()) {
        return err(new ExecutionError("spawn_error", `Working directory is not a directory: ${guarded.value.addressed}`));
      }
      const tempEnv = {
        TMPDIR: this.privateTempRoot,
        TMP: this.privateTempRoot,
        TEMP: this.privateTempRoot,
      };
      const env = options?.inheritEnv === false ? { ...tempEnv, ...options.env } : options?.env;
      const execOptions: ShellExecOptions =
        env === undefined
          ? { ...options, cwd: guarded.value.addressed }
          : { ...options, cwd: guarded.value.addressed, env };
      return await this.nodeEnv.exec(command, execOptions);
    } catch (error) {
      const cause = toError(error);
      return err(new ExecutionError("unknown", cause.message, cause));
    }
  }

  async cleanup(): Promise<void> {
    try {
      await this.nodeEnv.cleanup();
    } catch {}
    try {
      await this.mutationTail;
    } catch {}
    try {
      await rm(this.privateTempRoot, { recursive: true, force: true });
    } catch {}
  }

  private assertLexicalPath(path: string, field: string): void {
    if (!isWithin(this.workspaceRoot, path)) {
      throw new TypeError(`${field} must be inside workspaceRoot`);
    }
  }

  private assertCanonicalPath(canonical: string, addressed: string): void {
    if (!isWithin(this.canonicalWorkspaceRoot, canonical)) {
      throw new TypeError(`path escapes workspaceRoot: ${addressed}`);
    }
  }

  private addressedPath(path: string): Result<string, FileError> {
    if (typeof path !== "string" || path.includes("\0")) {
      return err(new FileError("invalid", "path must be a string without null bytes"));
    }
    const addressed = isAbsolute(path) ? resolve(path) : resolve(this.cwd, path);
    if (!isWithin(this.workspaceRoot, addressed)) {
      return err(new FileError("permission_denied", "path escapes workspaceRoot", addressed));
    }
    return ok(addressed);
  }

  private async guardExistingPathInput(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<GuardedPath, FileError>> {
    const addressed = this.addressedPath(path);
    if (!addressed.ok) return addressed;
    const abort = aborted<GuardedPath>(abortSignal, addressed.value);
    if (abort) return abort;
    return await this.guardExistingPath(addressed.value);
  }

  private async guardExistingPath(addressed: string): Promise<Result<GuardedPath, FileError>> {
    try {
      const canonical = await realpath(addressed);
      if (!isWithin(this.canonicalWorkspaceRoot, canonical)) {
        return err(new FileError("permission_denied", "symlink escapes workspaceRoot", addressed));
      }
      return ok({ addressed, canonical });
    } catch (error) {
      return err(toFileError(error, addressed));
    }
  }

  private async guardNearestExistingPath(addressed: string): Promise<Result<GuardedPath, FileError>> {
    let candidate = addressed;
    while (true) {
      const guarded = await this.guardExistingPath(candidate);
      if (guarded.ok) return guarded;
      if (guarded.error.code !== "not_found") return guarded;
      const parent = dirname(candidate);
      if (parent === candidate) return guarded;
      candidate = parent;
    }
  }

  private async followedOperation<T>(
    path: string,
    abortSignal: AbortSignal | undefined,
    operation: (addressed: string) => Promise<Result<T, FileError>>,
  ): Promise<Result<T, FileError>> {
    return await this.fileOperation(path, async () => {
      const guarded = await this.guardExistingPathInput(path, abortSignal);
      return guarded.ok ? await operation(guarded.value.addressed) : guarded;
    });
  }

  private async parentGuardedOperation<T>(
    path: string,
    abortSignal: AbortSignal | undefined,
    operation: (addressed: string) => Promise<Result<T, FileError>>,
  ): Promise<Result<T, FileError>> {
    return await this.fileOperation(path, async () => {
      const addressed = this.addressedPath(path);
      if (!addressed.ok) return addressed;
      const abort = aborted<T>(abortSignal, addressed.value);
      if (abort) return abort;
      if (addressed.value === this.workspaceRoot) return await operation(addressed.value);
      const parent = await this.guardNearestExistingPath(dirname(addressed.value));
      return parent.ok ? await operation(addressed.value) : parent;
    });
  }

  private async mutate(
    path: string,
    abortSignal: AbortSignal | undefined,
    guardTargetWhenExisting: boolean,
    operation: (addressed: string) => Promise<Result<void, FileError>>,
  ): Promise<Result<void, FileError>> {
    return await this.enqueueMutation(async () => {
      return await this.fileOperation(path, async () => {
        const addressed = this.addressedPath(path);
        if (!addressed.ok) return addressed;
        const abort = aborted<void>(abortSignal, addressed.value);
        if (abort) return abort;
        const guarded = guardTargetWhenExisting
          ? await this.guardNearestExistingPath(addressed.value)
          : await this.guardNearestExistingPath(dirname(addressed.value));
        return guarded.ok ? await operation(addressed.value) : guarded;
      });
    });
  }

  private async enqueueMutation<T>(operation: () => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
    const queued = this.mutationTail.then(operation, operation);
    this.mutationTail = queued.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await queued;
    } catch (error) {
      return err(toFileError(error));
    }
  }

  private async fileOperation<T>(
    fallbackPath: string | undefined,
    operation: () => Promise<Result<T, FileError>>,
  ): Promise<Result<T, FileError>> {
    try {
      return await operation();
    } catch (error) {
      return err(toFileError(error, fallbackPath));
    }
  }
}
