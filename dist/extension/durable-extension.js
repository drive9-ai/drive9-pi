import { defineExtension, section } from "@earendil-works/pi-durable";
import { withDrive9Effects } from "../workspace/wrap-tool.js";
export const DRIVE9_DURABLE_EXTENSION_NAME = "drive9-durable";
function toolWrap(name, coordinator, effect) {
    return {
        tool: name,
        wrap: (tool) => withDrive9Effects(tool, { coordinator, effect }),
    };
}
export function createDrive9DurableExtension(options) {
    return defineExtension({
        name: DRIVE9_DURABLE_EXTENSION_NAME,
        wraps: [
            toolWrap("write", options.coordinator, "workspace"),
            toolWrap("edit", options.coordinator, "workspace"),
            toolWrap("bash", options.coordinator, "workspace+external"),
        ],
        ...(options.prompt === false
            ? {}
            : {
                sections: [
                    section("drive9-workspace", ({ env }) => env === undefined
                        ? undefined
                        : "Your working directory is backed by a durable Drive9 workspace. Workspace mutations are checkpointed at successful tool boundaries."),
                ],
            }),
    });
}
//# sourceMappingURL=durable-extension.js.map