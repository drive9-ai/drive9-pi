import type {
  ExecutionEnv,
  FileSystem,
  Shell,
  ShellExecOptions,
} from "@earendil-works/pi-agent-core";

export interface ComposeExecutionEnvOptions {
  fileSystem: FileSystem;
  shell: Shell;
}

class ComposedExecutionEnv implements ExecutionEnv {
  private readonly fileSystem: FileSystem;
  private readonly shell: Shell;

  constructor(options: ComposeExecutionEnvOptions) {
    this.fileSystem = options.fileSystem;
    this.shell = options.shell;
  }

  get cwd(): string {
    return this.fileSystem.cwd;
  }

  set cwd(value: string) {
    this.fileSystem.cwd = value;
  }

  absolutePath: FileSystem["absolutePath"] = async (...args) => await this.fileSystem.absolutePath(...args);
  joinPath: FileSystem["joinPath"] = async (...args) => await this.fileSystem.joinPath(...args);
  readTextFile: FileSystem["readTextFile"] = async (...args) => await this.fileSystem.readTextFile(...args);
  readTextLines: FileSystem["readTextLines"] = async (...args) => await this.fileSystem.readTextLines(...args);
  readBinaryFile: FileSystem["readBinaryFile"] = async (...args) => await this.fileSystem.readBinaryFile(...args);
  writeFile: FileSystem["writeFile"] = async (...args) => await this.fileSystem.writeFile(...args);
  appendFile: FileSystem["appendFile"] = async (...args) => await this.fileSystem.appendFile(...args);
  renameFile: FileSystem["renameFile"] = async (...args) => await this.fileSystem.renameFile(...args);
  fileInfo: FileSystem["fileInfo"] = async (...args) => await this.fileSystem.fileInfo(...args);
  listDir: FileSystem["listDir"] = async (...args) => await this.fileSystem.listDir(...args);
  canonicalPath: FileSystem["canonicalPath"] = async (...args) => await this.fileSystem.canonicalPath(...args);
  exists: FileSystem["exists"] = async (...args) => await this.fileSystem.exists(...args);
  createDir: FileSystem["createDir"] = async (...args) => await this.fileSystem.createDir(...args);
  remove: FileSystem["remove"] = async (...args) => await this.fileSystem.remove(...args);
  createTempDir: FileSystem["createTempDir"] = async (...args) => await this.fileSystem.createTempDir(...args);
  createTempFile: FileSystem["createTempFile"] = async (...args) => await this.fileSystem.createTempFile(...args);

  exec(command: string, options?: ShellExecOptions): ReturnType<Shell["exec"]> {
    return this.shell.exec(command, options);
  }

  async cleanup(): Promise<void> {
    if ((this.fileSystem as unknown) === this.shell) {
      await this.fileSystem.cleanup().catch(() => undefined);
      return;
    }
    await Promise.allSettled([this.fileSystem.cleanup(), this.shell.cleanup()]);
  }
}

export function composeExecutionEnv(options: ComposeExecutionEnvOptions): ExecutionEnv {
  if (options.fileSystem === undefined || options.shell === undefined) {
    throw new TypeError("composeExecutionEnv requires explicit fileSystem and shell providers");
  }
  return new ComposedExecutionEnv(options);
}
