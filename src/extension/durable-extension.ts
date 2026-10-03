import { defineExtension, section, type Extension, type ToolRegistration, type Wrap } from "@earendil-works/pi-durable";
import type { WorkspaceMutationCoordinator } from "../workspace/types.js";
import { withDrive9Effects } from "../workspace/wrap-tool.js";

export const DRIVE9_DURABLE_EXTENSION_NAME = "drive9-durable";

export type Drive9DurableExtensionOptions = {
  readonly coordinator: WorkspaceMutationCoordinator;
  readonly prompt?: boolean;
};

function toolWrap(
  name: string,
  coordinator: WorkspaceMutationCoordinator,
  effect: "workspace" | "workspace+external",
): Wrap {
  return {
    tool: name,
    wrap: (tool: ToolRegistration) => withDrive9Effects(tool, { coordinator, effect }),
  };
}

export function createDrive9DurableExtension(options: Drive9DurableExtensionOptions): Extension {
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
            section(
              "drive9-workspace",
              ({ env }) =>
                env === undefined
                  ? undefined
                  : "Your working directory is backed by a durable Drive9 workspace. Workspace mutations are checkpointed at successful tool boundaries.",
            ),
          ],
        }),
  });
}
