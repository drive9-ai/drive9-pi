# drive9-pi

Turnkey Drive9 filesystem and durable tool-result evidence integration for Pi.

The normative contract is [`docs/design-lock.md`](docs/design-lock.md).

## Product Boundary

This package provides:

- `createDrive9PiIntegration`, the default one-call Pi `Agent` integration;
- `Drive9FileSystem`, a Pi `FileSystem` backed by the ordinary Drive9 SDK;
- `PersistentToolResultStore`, durable large-result storage with bounded read and search tools.

It does not provide a shell, compute, process isolation, a sandbox, or FUSE.
The default integration installs file and evidence tools only; it never creates
or falls back to a host shell.

## One-Call Pi Integration

`createDrive9PiIntegration` is the primary API. It installs Pi's model-visible
`read`, `write`, `edit`, and `list` tools on a Drive9-backed filesystem, installs
`result_read` and `result_search`, and composes durable large-result capture
with an existing `afterToolCall` hook.

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import { Client } from "drive9";
import { createDrive9PiIntegration } from "@drive9-ai/drive9-pi";

const drive9 = createDrive9PiIntegration({
  workspaceClient: new Client(baseUrl, workspaceKey),
  workspaceRoot: "/workspaces/agent-run-42",
  evidenceClient: new Client(baseUrl, evidenceKey),
  evidenceRoot: "/evidence/session-42",
  sessionId: "session-42",
  runId: "run-7",
  // Optional: shell: customerSandboxShell,
  // Optional: harnessTools: [createBashTool()],
});

const agent = new Agent(
  drive9.withAgentOptions({
    streamFn,
    initialState: {
      model,
      systemPrompt: "Use only read, write, edit, and list in the workspace.",
      tools: applicationTools,
    },
    afterToolCall: applicationAfterToolCall,
  }),
);
```

The application does not construct an `ExecutionEnv`, register Drive9 tools,
or attach the evidence fallback itself. Existing tools and hooks are preserved;
duplicate tool names and session mismatches fail during setup. No `exec` or
`bash` tool is installed by default. Applications that need command execution
may supply their sandbox `Shell` plus explicit Pi harness tools; those tools are
bound to the Drive9 filesystem and only that supplied shell. Without a shell,
`executionEnv.exec` fails with `shell_unavailable` and never reaches the host.
The system prompt is only model guidance: `withAgentOptions` performs the actual
filesystem injection by adding Drive9-bound tools to `initialState.tools`.

## Advanced Filesystem API

`Drive9FileSystem` maps Pi filesystem operations directly to Drive9 SDK
`read`, `write`, `append`, `list`, `stat`, `rename`, `mkdir`, and delete APIs.
It does not require a mount or a LayerFS layer.

```ts
import { Client } from "drive9";
import { Agent } from "@earendil-works/pi-agent-core";
import { createDrive9FileTools, Drive9FileSystem } from "@drive9-ai/drive9-pi";

const client = Client.defaultClient();
const fs = new Drive9FileSystem({
  client,
  root: "/workspaces/agent-run-42",
});

await fs.writeFile("src/auth.ts", "export const enabled = true;\n");
await fs.appendFile("logs/run.txt", "step completed\n");
const source = await fs.readTextFile("src/auth.ts");

const agent = new Agent({
  streamFn,
  initialState: {
    model,
    systemPrompt: "Use only read, write, edit, and list in the workspace.",
    tools: createDrive9FileTools({ fileSystem: fs }),
  },
});
```

The adapter normalizes every path inside `root`, maps backend failures to Pi
`FileError` results, creates parent directories for writes and appends, and
serializes mutations issued through one adapter instance. Recursive remove and
atomic rename use the corresponding Drive9 SDK operations. With the ordinary
Drive9 `Client`, bounded `readTextLines` reads from `readStream` and cancels as
soon as the requested number of lines is available. Temporary objects use
exclusive `createFile`/`mkdir` operations and failed cleanup remains retryable.

Drive9 paths are NFC-normalized before containment checks. Until a Drive9 SDK
release that safely encodes every URL path segment is available, `%`, `?`, `#`,
backslashes, ASCII controls, and malformed Unicode are rejected before any SDK
call. Spaces and well-formed Unicode filenames remain supported.

This default adapter mutates the live Drive9 filesystem. It does not create a
layer and does not promise branch, checkpoint, or rollback semantics. A future
LayerFS adapter can be added separately if a concrete rollback workflow is
required.

## Advanced Evidence API

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
the executor. `result_read` and `result_search` outputs are never recursively
offloaded by the fallback.

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
