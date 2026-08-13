# drive9-pi

Drive9 SDK filesystem and durable tool-result evidence adapters for Pi.

The normative contract is [`docs/design-lock.md`](docs/design-lock.md).

## Product Boundary

This package provides:

- `Drive9FileSystem`, a Pi `FileSystem` backed by the ordinary Drive9 SDK;
- `PersistentToolResultStore`, durable large-result storage with bounded read and search tools.

It does not provide a shell, compute, process isolation, a sandbox, FUSE, or a
Pi `ExecutionEnv` compositor. Applications assemble their own execution
environment and supply their own shell when command execution is required.

## Drive9FileSystem

`Drive9FileSystem` maps Pi filesystem operations directly to Drive9 SDK
`read`, `write`, `append`, `list`, `stat`, `rename`, `mkdir`, and delete APIs.
It does not require a mount or a LayerFS layer.

```ts
import { Client } from "drive9";
import { Drive9FileSystem } from "@drive9-ai/drive9-pi";

const client = Client.defaultClient();
const fs = new Drive9FileSystem({
  client,
  root: "/workspaces/agent-run-42",
});

await fs.writeFile("src/auth.ts", "export const enabled = true;\n");
await fs.appendFile("logs/run.txt", "step completed\n");
const source = await fs.readTextFile("src/auth.ts");
```

The adapter normalizes every path inside `root`, maps backend failures to Pi
`FileError` results, creates parent directories for writes and appends, and
serializes mutations issued through one adapter instance. Recursive remove and
atomic rename use the corresponding Drive9 SDK operations.

This default adapter mutates the live Drive9 filesystem. It does not create a
layer and does not promise branch, checkpoint, or rollback semantics. A future
LayerFS adapter can be added separately if a concrete rollback workflow is
required.

## Tool Result Evidence

`PersistentToolResultStore` stores immutable output chunks and publishes a
stable reference only after a CAS-protected terminal manifest is durable.

```ts
import { createDrive9ResultStore } from "@drive9-ai/drive9-pi";

const results = createDrive9ResultStore({
  client: evidenceClient,
  evidenceRoot: "/evidence/session-42",
});
```

The package provides:

- `createAfterToolCallFallback` for oversized all-text results;
- `createResultSearchTool` for bounded literal search;
- `createResultReadTool` for bounded line reads.

It intentionally does not provide a command-execution tool. A caller tool may
stream stdout or stderr into `ToolResultStore`, but the caller runtime remains
the executor.

## Evidence Isolation

`verifyEvidenceIsolation` checks that workspace and evidence roots are
disjoint, verifies create/read/replace/delete with the evidence credential,
and requires explicit authorization denial for workspace-credential access to
the evidence root.

## Validation

```bash
npm test
npm run check
npm run check:e2e
npm run build
```
