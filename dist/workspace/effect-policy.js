const READ_ONLY_TOOLS = new Set(["read", "ls", "grep", "find"]);
const WORKSPACE_TOOLS = new Set(["write", "edit"]);
export function defaultDrive9Effect(toolName, receivesEnvironment) {
    if (READ_ONLY_TOOLS.has(toolName))
        return "none";
    if (WORKSPACE_TOOLS.has(toolName))
        return "workspace";
    if (!receivesEnvironment)
        return "external";
    return "workspace+external";
}
export function drive9ReplayPolicy(effect) {
    return effect === "workspace" ? "safe" : "unsafe";
}
//# sourceMappingURL=effect-policy.js.map