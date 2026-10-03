import type { Drive9Effect } from "./types.js";

const READ_ONLY_TOOLS = new Set(["read", "ls", "grep", "find"]);
const WORKSPACE_TOOLS = new Set(["write", "edit"]);

export function defaultDrive9Effect(toolName: string, receivesEnvironment: boolean): Drive9Effect {
  if (READ_ONLY_TOOLS.has(toolName)) return "none";
  if (WORKSPACE_TOOLS.has(toolName)) return "workspace";
  if (!receivesEnvironment) return "external";
  return "workspace+external";
}

export function drive9ReplayPolicy(effect: Drive9Effect): "safe" | "unsafe" {
  return effect === "workspace" ? "safe" : "unsafe";
}
