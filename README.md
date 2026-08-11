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

## ToolResultStore

`PersistentToolResultStore` implements the design-locked immutable chunk and
CAS-terminal-manifest protocol. It provides stable result identities,
idempotent append/finalize retries, explicit `unknown` recovery, and bounded
line, byte-range, and literal-search reads.

The store is independent of one filesystem client. Its `ResultStoreBackend`
must provide three operations over an evidence-only namespace:

- `create` is insert-only and reports `conflict` when the path exists;
- `replace` is compare-and-swap against a positive observed revision;
- `read` returns immutable bytes plus their positive revision.

Backend failures use `ResultStoreError` codes. Unexpected backend failures are
reported as `unavailable`; missing or malformed stored evidence fails closed.
The store serializes mutations for one result within one store instance, while
the backend CAS remains the authority across clients and processes.

```ts
import { PersistentToolResultStore } from "@drive9-ai/drive9-pi";

const results = new PersistentToolResultStore({ backend: evidenceBackend });
const begun = await results.begin({
  identity: { sessionId, runId, toolCallId, attempt: 0 },
  toolName: "drive9_exec",
  mediaType: "text/plain; charset=utf-8",
});
```

The Drive9 evidence backend and Pi tool adapters are delivered separately so
the persistence protocol can be tested without model or process execution.
