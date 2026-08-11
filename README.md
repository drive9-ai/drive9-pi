# drive9-pi

Drive9-backed execution and durable tool-result evidence for Pi agents.

The implementation contract is defined in
[`docs/design-lock.md`](docs/design-lock.md).

## Drive9ExecutionEnv

`Drive9ExecutionEnv` implements Pi's complete `ExecutionEnv` contract over a
Drive9 FUSE workspace. It confines Pi filesystem paths and shell working
directories to one mount root, maps failures to Pi errors, serializes local
mutations, and creates private temporary paths inside the workspace.

```ts
import { Drive9ExecutionEnv } from "@drive9-ai/drive9-pi";

const env = new Drive9ExecutionEnv({
  workspaceRoot: "/mnt/drive9/workspace",
});
```

This is path confinement, not an OS sandbox. Commands can still access host
absolute paths and the network unless the deployment supplies a separate
sandbox.
