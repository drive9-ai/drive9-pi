import {} from "@earendil-works/pi-durable/env";
import { Drive9DurableFileSystem, } from "../drive9-durable-file-system.js";
import { createDrive9RuntimeExec, } from "./runtime-shell.js";
/**
 * Pi 1.0 environment for agents using the Drive9 SDK directly (ordinary root).
 *
 * The filesystem and the shell share ONE authenticated client and the same
 * ordinary Drive9 root: a command run through `exec` sees files the agent wrote
 * via the filesystem, and vice versa. Commands never fall through to the host.
 * LayerFS and the coding-agent host-temp bash path are out of scope
 * (see docs/design/runtime-exec-integration.md).
 */
export class Drive9SdkExecutionEnv extends Drive9DurableFileSystem {
    #exec;
    constructor(options) {
        super(options);
        const spill = {
            create: async (context) => {
                const created = await this.createTempFile({ prefix: "runtime-exec-", suffix: ".log" }, context);
                if (!created.ok)
                    throw created.error;
                return created.value;
            },
            append: async (path, bytes, context) => {
                const appended = await this.appendFile(path, bytes, context);
                if (!appended.ok)
                    throw appended.error;
            },
        };
        this.#exec = createDrive9RuntimeExec({
            client: options.client,
            root: this.root,
            currentCwd: () => this.cwd,
            spill,
        });
    }
    async exec(command, options, context) {
        return await this.#exec(command, options, context);
    }
}
//# sourceMappingURL=sdk-environment.js.map