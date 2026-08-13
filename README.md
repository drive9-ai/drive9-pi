# drive9-pi

SDK-backed Drive9 workspace storage and durable tool-result evidence for Pi.

The normative contract is [`docs/design-lock.md`](docs/design-lock.md).

## Product Boundary

Drive9 provides persistent files and evidence. It does not provide a shell,
compute, process isolation, or a sandbox.

Pi separates those capabilities:

```ts
interface FileSystem { /* files */ }
interface Shell { exec(...): Promise<Result<...>> }
interface ExecutionEnv extends FileSystem, Shell {}
```

This package implements the `FileSystem` side. Applications supply their own
`Shell` from a sandbox or runtime when they need command execution.

## Drive9FileSystem

`Drive9FileSystem` addresses one active LayerFS layer through the Drive9 SDK.
It does not require FUSE, WebDAV, a mount, or `node:fs`.

```ts
import { Client } from "drive9";
import { Drive9FileSystem } from "@drive9-ai/drive9-pi";

const client = Client.defaultClient();
const fs = new Drive9FileSystem({
  client,
  layerId: "agent-run-42",
  root: "/workspaces/agent-run-42",
});

await fs.writeFile("src/auth.ts", "export const enabled = true;\n");
const source = await fs.readTextFile("src/auth.ts");
```

The adapter merges base children with effective layer entries for reads,
`stat`, and directory listing. `maxLayerEntries` and `viewTimeoutMs` bound
whole-layer view assembly. Writes and whiteouts use LayerFS APIs so
abandoning the layer restores the base.

Current explicit limitations:

- append is unsupported because LayerFS has no append/CAS primitive;
- atomic rename is unsupported because the SDK lacks a merged target view;
- recursive remove is unsupported to avoid partial tree deletion;
- symlink canonicalization is unsupported;
- merged list/stat enumerate the whole layer and may be expensive for large
  layers.

Merged operations capture one LayerFS durable sequence with `diffFSLayer` and retry if the layer
moves while the view is assembled. They require the layer base root to remain
unchanged while the layer is active; the current server has no atomic merged
base/layer snapshot endpoint. `maxLayerEntries` and `viewTimeoutMs` bound
whole-layer view assembly.

These methods return `FileError("not_supported")`; they do not partially
mutate data. Do not use this adapter as Pi's JSONL session repository until
LayerFS gains append and atomic rename semantics.

## Caller-Owned Shell

When an application requires a full `ExecutionEnv`, combine the Drive9
filesystem with a caller-owned shell:

```ts
import { composeExecutionEnv } from "@drive9-ai/drive9-pi";

const env = composeExecutionEnv({
  fileSystem: fs,
  shell: customerSandboxShell,
});
```

The compositor delegates only. It resolves the command working directory
against the current filesystem `cwd`, passes that absolute path to the supplied
shell, and preserves every other execution option. It does not create a local
process or fall back to the host shell. Without a supplied shell, use
`Drive9FileSystem` directly and do not register exec/bash tools.

A bare shell process does not call the Drive9 SDK, so its filesystem side
effects are not automatically recorded. Customers that require transparent
POSIX tooling must provide their own mount or synchronization bridge inside
their runtime.

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
stream its own stdout/stderr into `ToolResultStore`, but
the caller runtime remains the executor.

## Workspace Revisions

`Drive9LayerWorkspaceRevisionProvider` calls the SDK checkpoint endpoint after
awaited SDK mutations. No mount drain is required.

A checkpoint is a durable sequence observation. `rollbackFSLayer(layerId)`
abandons the whole active layer and returns to base; it does not rewind an
active layer to an arbitrary checkpoint.

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
