# drive9-pi

Drive9 filesystem and durable tool-result evidence integration for Pi.

The normative contract is [`docs/design-lock.md`](docs/design-lock.md).

## Install as a Pi Package

`drive9-pi` follows Pi's normal package and remote-filesystem pattern: install
the package, select a Drive9 root, and keep using the ordinary `pi` command.

```bash
# From npm after the first release:
pi install npm:@drive9-ai/drive9-pi

# Or directly from the public repository:
pi install https://github.com/drive9-ai/drive9-pi
```

Configure the ordinary Drive9 SDK through `~/.drive9/config`, or with the same
environment variables used by `Client.defaultClient()`:

```bash
export DRIVE9_SERVER="https://api.drive9.ai"
export DRIVE9_API_KEY="d9_..."

pi --drive9-root /workspaces/my-project
```

`DRIVE9_PI_ROOT=/workspaces/my-project pi` is equivalent. The root must already
exist, must be a directory, and cannot be the tenant root `/`. Without
`--drive9-root` or `DRIVE9_PI_ROOT`, the extension is inactive and Pi keeps its
normal local tools.

When Drive9 mode is active, the extension replaces Pi's filesystem tools with
the official coding-agent tool factories and their standard schemas/result
shapes:

- `read`, `write`, and `edit` use Drive9 SDK operations;
- `ls` is Pi's canonical directory-listing tool backed by Drive9;
- relative paths resolve from the selected Drive9 root;
- the system prompt identifies the Drive9 workspace.

Drive9 is storage, not compute. In Drive9 mode, model `bash`, `grep`, and `find`
calls and interactive `!` commands fail closed instead of falling back to the
host filesystem. Applications that need a shared filesystem and process world
must provide a separate sandbox or mount bridge; this package never pretends a
local process can open an SDK-only Drive9 path.

## Programmatic Coding-Agent Integration

Pi extensions that need explicit configuration can reuse the same extension
factory:

```ts
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Client } from "drive9";
import { createDrive9PiExtension } from "@drive9-ai/drive9-pi";

const extension: ExtensionFactory = createDrive9PiExtension({
  defaultRoot: "/workspaces/my-project",
  createClient: () => Client.defaultClient(),
});

export default extension;
```

For lower-level composition, `createDrive9CodingAgentTools` returns Pi's
official `read`, `write`, `edit`, `ls`, and `bash` definitions. The bash
definition is intentionally storage-only and returns an error; it never starts
a host process. The remote edit tool omits Pi's local-filesystem preview
renderer so rendering cannot read a same-named host file before the Drive9 edit
executes. Custom hosts that register only these definitions must also block any
separately enabled local `grep`, `find`, and interactive `!` execution, as
`createDrive9PiExtension` does.

## Low-Level Agent SDK and Evidence

`createDrive9PiIntegration` remains available for applications built directly
on `@earendil-works/pi-agent-core`. It binds the harness `read`, `write`, and
`edit` tools plus a Drive9-specific direct-child `list` tool, adds bounded
`result_read` and `result_search`, and composes durable large-result capture
with an existing `afterToolCall` hook.

The six required integration fields are explicit. Workspace and evidence
credentials should be different scoped Drive9 credentials:

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import { Client } from "drive9";
import { createDrive9PiIntegration } from "@drive9-ai/drive9-pi";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const workspaceClient = Client.defaultClient();
const evidenceClient = new Client(
  required("DRIVE9_EVIDENCE_SERVER"),
  required("DRIVE9_EVIDENCE_API_KEY"),
);

const drive9 = createDrive9PiIntegration({
  workspaceClient,
  workspaceRoot: required("DRIVE9_WORKSPACE_ROOT"),
  evidenceClient,
  evidenceRoot: required("DRIVE9_EVIDENCE_ROOT"),
  sessionId: required("PI_SESSION_ID"),
  runId: required("PI_RUN_ID"),
});

const agent = new Agent(
  drive9.withAgentOptions({
    streamFn,
    initialState: { model, tools: applicationTools },
    afterToolCall: applicationAfterToolCall,
  }),
);
```

The application does not construct an execution environment or attach the
evidence fallback itself. Existing tools and hooks are preserved; duplicate
tool names and session mismatches fail during setup. No shell is installed by
default. A caller may explicitly supply its own sandbox `Shell` and selected Pi
harness tools; without one, `executionEnv.exec` returns `shell_unavailable` and
never reaches the host.

The low-level harness tool is named `list` because `pi-agent-core` does not
provide the coding-agent `ls` definition. This is an intentional compatibility
surface, not a claim that `list` is a standard Pi coding-agent tool. Public Pi
CLI usage should use the package extension above and its canonical `ls` tool.

## Filesystem API

`Drive9FileSystem` implements Pi's `FileSystem` and maps operations directly to
Drive9 SDK `read`, `write`, `append`, `list`, `stat`, `rename`, `mkdir`, and
delete APIs. It does not require a mount or LayerFS layer.

```ts
import { getOrThrow } from "@earendil-works/pi-agent-core";
import { Client } from "drive9";
import { Drive9FileSystem } from "@drive9-ai/drive9-pi";

const fileSystem = new Drive9FileSystem({
  client: Client.defaultClient(),
  root: "/workspaces/my-project",
});

getOrThrow(await fileSystem.writeFile("src/auth.ts", "export const enabled = true;\n"));
const source = getOrThrow(await fileSystem.readTextFile("src/auth.ts"));
```

The adapter normalizes every path inside `root`, maps backend failures to Pi
`FileError` results, creates parent directories for writes and appends, and
serializes mutations issued through one adapter instance. Recursive remove and
atomic rename use the corresponding Drive9 SDK operations. Bounded
`readTextLines` reads from `readStream` and cancels once enough lines arrive.
Temporary objects use exclusive create operations and failed cleanup remains
retryable.

Drive9 paths are NFC-normalized before containment checks. Until a Drive9 SDK
release that safely encodes every URL path segment is available, `%`, `?`, `#`,
backslashes, ASCII controls, and malformed Unicode are rejected before any SDK
call. Spaces and well-formed Unicode filenames remain supported.

This adapter mutates the live Drive9 filesystem. It does not create a layer and
does not promise branch, checkpoint, or rollback semantics.

## Evidence API

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
disjoint, verifies create/read/replace/delete with the evidence credential, and
requires explicit authorization denial for workspace-credential access to the
evidence root.

## Validation

```bash
npm test
npm run check
npm run check:e2e
npm run build
npm pack --dry-run
```
