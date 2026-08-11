import { isAbsolute, join } from "node:path";
import { ResultStoreError } from "./tool-result-types.js";

export interface PrivateCommandEnvironmentOptions {
  home: string;
  path: string;
}

function requireAbsolutePath(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new ResultStoreError("invalid", `${label} must be an absolute path`);
  }
  return value;
}

export function createPrivateCommandEnvironment(options: PrivateCommandEnvironmentOptions): Record<string, string> {
  const home = requireAbsolutePath(options.home, "home");
  if (typeof options.path !== "string" || options.path.length === 0 || options.path.includes("\0")) {
    throw new ResultStoreError("invalid", "path must be non-empty");
  }
  return {
    PATH: options.path,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
}

export function createTrustedHelperEnvironment(values: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...values };
  for (const name of ["PATH", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined && environment[name] === undefined) environment[name] = value;
  }
  return environment;
}
