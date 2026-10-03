import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { Drive9Effect, WorkspaceMutationCoordinator } from "./types.js";
export type Drive9ToolEffectOptions = {
    readonly coordinator: WorkspaceMutationCoordinator;
    readonly effect?: Drive9Effect;
};
export declare function withDrive9Effects<Tool extends ToolRegistration>(tool: Tool, options: Drive9ToolEffectOptions): Tool;
//# sourceMappingURL=wrap-tool.d.ts.map