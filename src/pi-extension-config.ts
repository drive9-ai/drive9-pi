import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { normalizeDrive9AbsoluteRoot } from "./drive9-path.js";

export const DRIVE9_EXTENSION_CONFIG_VERSION = 1 as const;
export const DRIVE9_EXTENSION_CONFIG_FILENAME = "drive9.json";
export const DRIVE9_PROJECT_TRUST_MARKER_FILENAME = "settings.json";

export interface Drive9ExtensionConfig {
  version: typeof DRIVE9_EXTENSION_CONFIG_VERSION;
  enabled: boolean;
  root: string;
}

export class Drive9ExtensionConfigError extends Error {
  readonly configPath: string | undefined;
  readonly cause: unknown;

  constructor(message: string, configPath?: string, cause?: unknown) {
    super(message);
    this.name = "Drive9ExtensionConfigError";
    this.configPath = configPath;
    this.cause = cause;
  }
}

/** Minimal injectable filesystem surface used by config reads and atomic writes. */
export interface Drive9ExtensionConfigIO {
  pathExists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  makeDirectory(path: string): Promise<void>;
  writeTextExclusive(path: string, content: string): Promise<void>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const DEFAULT_CONFIG_IO: Drive9ExtensionConfigIO = {
  pathExists: async (path) => {
    try {
      await access(path);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  },
  readText: async (path) => await readFile(path, "utf8"),
  makeDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeTextExclusive: async (path, content) => {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  },
  rename: async (sourcePath, destinationPath) => {
    await rename(sourcePath, destinationPath);
  },
  remove: async (path) => {
    await unlink(path);
  },
};

const CONFIG_KEYS = new Set(["version", "enabled", "root"]);

export function getDrive9ProjectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, DRIVE9_EXTENSION_CONFIG_FILENAME);
}

export function getDrive9ProjectTrustMarkerPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, DRIVE9_PROJECT_TRUST_MARKER_FILENAME);
}

function invalidConfig(message: string, configPath?: string, cause?: unknown): Drive9ExtensionConfigError {
  const location = configPath === undefined ? "Drive9 extension config" : `Drive9 extension config at ${configPath}`;
  return new Drive9ExtensionConfigError(`${location}: ${message}`, configPath, cause);
}

function invalidTrustMarker(message: string, markerPath: string, cause?: unknown): Drive9ExtensionConfigError {
  return new Drive9ExtensionConfigError(
    `Pi project trust marker at ${markerPath}: ${message}`,
    markerPath,
    cause,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateDrive9ExtensionConfig(
  value: unknown,
  configPath?: string,
): Drive9ExtensionConfig {
  if (!isRecord(value)) throw invalidConfig("expected a JSON object", configPath);

  const unknownKeys = Object.keys(value).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw invalidConfig(`unknown key${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`, configPath);
  }
  for (const key of CONFIG_KEYS) {
    if (!Object.hasOwn(value, key)) throw invalidConfig(`missing required key: ${key}`, configPath);
  }
  if (value.version !== DRIVE9_EXTENSION_CONFIG_VERSION) {
    throw invalidConfig(`version must be ${DRIVE9_EXTENSION_CONFIG_VERSION}`, configPath);
  }
  if (typeof value.enabled !== "boolean") {
    throw invalidConfig("enabled must be a boolean", configPath);
  }

  let root: string;
  try {
    root = normalizeDrive9AbsoluteRoot(value.root, "root", (message) => new TypeError(message));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalidConfig(message, configPath, error);
  }

  return {
    version: DRIVE9_EXTENSION_CONFIG_VERSION,
    enabled: value.enabled,
    root,
  };
}

export function parseDrive9ExtensionConfig(text: string, configPath?: string): Drive9ExtensionConfig {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw invalidConfig("invalid JSON", configPath, error);
  }
  return validateDrive9ExtensionConfig(value, configPath);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

export interface EnsureDrive9ProjectTrustMarkerOptions {
  cwd: string;
  trusted: boolean;
  io?: Drive9ExtensionConfigIO;
}

/**
 * Ensure Pi can discover that this project requires a trust decision. Existing
 * project settings are preserved byte-for-byte; only a missing marker is
 * created, using an exclusive write to avoid races with Pi or the user.
 */
export async function ensureDrive9ProjectTrustMarker(
  options: EnsureDrive9ProjectTrustMarkerOptions,
): Promise<string> {
  const markerPath = getDrive9ProjectTrustMarkerPath(options.cwd);
  if (!options.trusted) {
    throw invalidTrustMarker("refusing to write for an untrusted project", markerPath);
  }

  const io = options.io ?? DEFAULT_CONFIG_IO;
  try {
    await io.makeDirectory(dirname(markerPath));
  } catch (error) {
    throw invalidTrustMarker("parent directory could not be created", markerPath, error);
  }

  try {
    await io.writeTextExclusive(markerPath, "{}\n");
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw invalidTrustMarker("could not be created", markerPath, error);
    }
  }
  return markerPath;
}

export interface ReadDrive9ProjectConfigOptions {
  cwd: string;
  trusted: boolean;
  io?: Drive9ExtensionConfigIO;
}

/**
 * Read trusted project configuration. Untrusted projects are deliberately
 * indistinguishable from projects without configuration and are never read.
 */
export async function readDrive9ProjectConfig(
  options: ReadDrive9ProjectConfigOptions,
): Promise<Drive9ExtensionConfig | undefined> {
  if (!options.trusted) return undefined;
  const configPath = getDrive9ProjectConfigPath(options.cwd);
  const markerPath = getDrive9ProjectTrustMarkerPath(options.cwd);
  const io = options.io ?? DEFAULT_CONFIG_IO;
  try {
    if (!(await io.pathExists(markerPath))) return undefined;
  } catch (error) {
    throw invalidTrustMarker("could not be checked", markerPath, error);
  }

  let text: string;
  try {
    text = await io.readText(configPath);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw invalidConfig("could not be read", configPath, error);
  }
  return parseDrive9ExtensionConfig(text, configPath);
}

export interface WriteDrive9ProjectConfigOptions {
  cwd: string;
  trusted: boolean;
  config: Drive9ExtensionConfig;
  io?: Drive9ExtensionConfigIO;
}

/** Write only the validated, non-sensitive config fields using same-directory rename. */
export async function writeDrive9ProjectConfig(
  options: WriteDrive9ProjectConfigOptions,
): Promise<string> {
  const configPath = getDrive9ProjectConfigPath(options.cwd);
  if (!options.trusted) {
    throw invalidConfig("refusing to write configuration for an untrusted project", configPath);
  }
  const config = validateDrive9ExtensionConfig(options.config, configPath);
  const io = options.io ?? DEFAULT_CONFIG_IO;
  const directory = dirname(configPath);
  const temporaryPath = join(
    directory,
    `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const content = `${JSON.stringify(
    { version: config.version, enabled: config.enabled, root: config.root },
    null,
    2,
  )}\n`;

  await ensureDrive9ProjectTrustMarker({ cwd: options.cwd, trusted: true, io });
  let temporaryCreated = false;
  try {
    await io.writeTextExclusive(temporaryPath, content);
    temporaryCreated = true;
    await io.rename(temporaryPath, configPath);
  } catch (error) {
    if (temporaryCreated) {
      try {
        await io.remove(temporaryPath);
      } catch {}
    }
    throw invalidConfig("could not be written atomically", configPath, error);
  }
  return configPath;
}

export type Drive9ExtensionConfigSource =
  | "no-drive9"
  | "cli"
  | "env"
  | "project"
  | "programmatic"
  | "none";

export type ResolvedDrive9ExtensionConfig =
  | {
      status: "active";
      source: "cli" | "env" | "project" | "programmatic";
      root: string;
    }
  | {
      status: "inactive";
      source: "no-drive9" | "project" | "none";
      reason: "disabled" | "unconfigured";
    }
  | {
      status: "error";
      source: Exclude<Drive9ExtensionConfigSource, "none">;
      error: Drive9ExtensionConfigError;
    };

export interface ResolveDrive9ExtensionConfigOptions {
  cwd: string;
  projectTrusted: boolean;
  noDrive9?: boolean | string;
  cliRoot?: boolean | string;
  environment?: Readonly<Record<string, string | undefined>>;
  defaultRoot?: string;
  io?: Drive9ExtensionConfigIO;
}

type ActiveOrError = Extract<ResolvedDrive9ExtensionConfig, { status: "active" | "error" }>;

function resolveRootCandidate(
  source: "cli" | "env" | "programmatic",
  value: unknown,
  label: string,
): ActiveOrError {
  try {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`${label} requires an absolute Drive9 path`);
    }
    const root = normalizeDrive9AbsoluteRoot(value.trim(), label, (message) => new TypeError(message));
    return { status: "active", source, root };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      source,
      error: new Drive9ExtensionConfigError(message, undefined, error),
    };
  }
}

/** Resolve activation lazily in documented precedence order. */
export async function resolveDrive9ExtensionConfig(
  options: ResolveDrive9ExtensionConfigOptions,
): Promise<ResolvedDrive9ExtensionConfig> {
  if (options.noDrive9 === true) {
    return { status: "inactive", source: "no-drive9", reason: "disabled" };
  }
  if (options.noDrive9 !== undefined && options.noDrive9 !== false) {
    return {
      status: "error",
      source: "no-drive9",
      error: new Drive9ExtensionConfigError("--no-drive9 must be a boolean"),
    };
  }

  if (options.cliRoot !== undefined && options.cliRoot !== false) {
    return resolveRootCandidate("cli", options.cliRoot, "--drive9-root");
  }

  const environment = options.environment ?? process.env;
  if (environment.DRIVE9_PI_ROOT !== undefined) {
    return resolveRootCandidate("env", environment.DRIVE9_PI_ROOT, "DRIVE9_PI_ROOT");
  }

  let projectConfig: Drive9ExtensionConfig | undefined;
  try {
    projectConfig = await readDrive9ProjectConfig({
      cwd: options.cwd,
      trusted: options.projectTrusted,
      ...(options.io === undefined ? {} : { io: options.io }),
    });
  } catch (error) {
    const configError =
      error instanceof Drive9ExtensionConfigError
        ? error
        : invalidConfig("could not be resolved", getDrive9ProjectConfigPath(options.cwd), error);
    return { status: "error", source: "project", error: configError };
  }
  if (projectConfig !== undefined) {
    if (!projectConfig.enabled) {
      return { status: "inactive", source: "project", reason: "disabled" };
    }
    return { status: "active", source: "project", root: projectConfig.root };
  }

  if (options.defaultRoot !== undefined) {
    return resolveRootCandidate("programmatic", options.defaultRoot, "defaultRoot");
  }

  return { status: "inactive", source: "none", reason: "unconfigured" };
}
