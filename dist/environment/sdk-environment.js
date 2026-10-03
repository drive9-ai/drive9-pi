import { err, ExecutionError, } from "@earendil-works/pi-durable/env";
import { Drive9DurableFileSystem, } from "../drive9-durable-file-system.js";
/**
 * Pi 1.0 environment for file-only agents using the Drive9 SDK directly.
 *
 * The filesystem and environment share one namespace identity. Shell execution
 * always fails closed; commands never fall through to the host process.
 *
 * This environment remains preview until Drive9 SDK acknowledgement durability
 * is proven against a real backend from another process.
 */
export class Drive9SdkExecutionEnv extends Drive9DurableFileSystem {
    async exec(_command, _options, context) {
        if (context.abortSignal?.aborted)
            return err(new ExecutionError("aborted", "aborted"));
        return err(new ExecutionError("shell_unavailable", "Drive9SdkExecutionEnv provides filesystem access only; shell execution is unavailable"));
    }
}
//# sourceMappingURL=sdk-environment.js.map