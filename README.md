# drive9-pi

Drive9 filesystem and durable tool-result evidence integration for Pi.

The normative contract is [`docs/design-lock.md`](docs/design-lock.md).

## Install

Install the public npm package through Pi's standard package manager:

```bash
# Personal install: recorded in ~/.pi/agent/settings.json
pi install npm:@drive9/drive9-pi

# Team/project install: recorded in .pi/settings.json
pi install -l npm:@drive9/drive9-pi
git add .pi/settings.json
```

To test an unreleased repository revision instead, use Pi's Git package source:

```bash
pi install git:github.com/drive9-ai/drive9-pi@tag-or-commit
pi install -l git:github.com/drive9-ai/drive9-pi@tag-or-commit
```

After a teammate trusts the project, Pi installs a missing project package on
startup. Pi packages execute code with the permissions of the Pi process, so
review packages before trusting them. For Git sources, Pi's normal
`@tag-or-commit` suffix pins the exact revision.

## Authenticate Drive9

The extension uses the normal Drive9 SDK credentials. Configure them once in
`~/.drive9/config`, or provide the same environment variables consumed by
`Client.defaultClient()`:

```bash
export DRIVE9_SERVER="https://api.drive9.ai"
export DRIVE9_API_KEY="d9_..."
```

`/drive9 setup` does **not** ask for, write, or copy Drive9 credentials. In
particular, `.pi/drive9.json` contains only non-secret project settings and can
be shared independently of each teammate's Drive9 credentials.

## Configure a Project

Start Pi from the local project that should use Drive9:

```bash
cd ./my-project
pi
```

Inside Pi, run:

```text
/drive9 setup
```

Choose `/workspaces/my-project` when prompted. You can also supply the root
directly as `/drive9 setup /workspaces/my-project`. Everything after `setup`
is treated as the root, so `/drive9 setup /workspaces/team project` also works.
Setup performs a Drive9 preflight before changing the project: credentials must
work, the root must be a directory, and it cannot be the tenant root `/`. If
the root is missing, setup can create it and any missing parent directories
after one confirmation. The Drive9 CLI is not required for setup.

After a successful preflight, setup ensures `.pi/settings.json` exists as Pi's
standard project-trust marker, atomically writes `.pi/drive9.json`, and reloads
Pi. It never overwrites an existing `.pi/settings.json`. A failed preflight
leaves the previous configuration untouched.

The generated file has this strict, versioned shape:

```json
{
  "version": 1,
  "enabled": true,
  "root": "/workspaces/my-project"
}
```

See [`schema/drive9.schema.json`](schema/drive9.schema.json) for the JSON
Schema. A project configuration is valid only when `.pi/settings.json` is also
present and Pi trusts the project; a standalone `.pi/drive9.json` is not
loaded. Commit both files when the whole team should use the same Drive9 root.

## Commands and State

All management commands are available in interactive Pi sessions:

| Command | Behavior |
| --- | --- |
| `/drive9 setup [root]` | Prompt for a root when omitted, preflight it, atomically save it, and reload Pi. It never collects authentication. |
| `/drive9 status` | Report the resolved state, configuration source, root, trust status, and last successful check without exposing secrets. An unavailable state includes its initialization error. |
| `/drive9 disable` | For project or programmatic activation, save `enabled: false` while retaining the root, then reload Pi. CLI and environment overrides must instead be removed or suppressed with `--no-drive9`. |
| `/drive9 verify` | Perform a read-only `stat`/`list` verification. |
| `/drive9 verify write` | Write, read back, and explicitly delete a randomly named temporary file. Success means that delete completed; a detected cleanup failure is reported as a verification failure. |

The footer reflects the resolved runtime state:

| State | Footer | Meaning |
| --- | --- | --- |
| Inactive | none | No Drive9 root was requested; Pi uses its ordinary local tools. |
| Disabled | `Drive9: off` | The project config is disabled, or `--no-drive9` was used. |
| Checking | `Drive9: checking…` | Drive9 preflight is in progress. |
| Active | `Drive9: /workspaces/my-project` | Filesystem operations are routed to the selected root. |
| Unavailable | `Drive9: unavailable` | Drive9 was requested but preflight failed; the extension does not fall back to local files. |

## One-Shot and Headless Usage

Flags override the saved project choice for one process and never rewrite
`.pi/drive9.json`:

```bash
# Use a different root for this session
pi --drive9-root /workspaces/one-off

# Keep Drive9 disabled for this session
pi --no-drive9
```

`DRIVE9_PI_ROOT=/workspaces/one-off pi` remains available for environment-based
automation. The explicit CLI flags are clearer for manual one-shot use.

Non-interactive modes never open the setup UI or create project configuration.
When an enabled project config, `DRIVE9_PI_ROOT`, or `--drive9-root` explicitly
requests Drive9 and preflight fails, the extension reports a
`DRIVE9_INIT_FAILED` extension error and keeps the Drive9-controlled tool
surface fail-closed instead of silently using local filesystem tools. Pi hosts
decide how extension errors affect provider turns and process exit status, so
automation must treat that extension error as fatal rather than relying only
on a non-zero exit code. With no Drive9 request, or with Drive9 explicitly
disabled, normal local Pi behavior remains available.

Project-local packages and `.pi/drive9.json` require project trust. Headless
Pi does not show a trust prompt, so use a saved trust decision or pass
`--approve` only after reviewing the project:

```bash
pi --approve --drive9-root /workspaces/my-project -p \
  'Write "hello from headless Pi" to headless.txt'
```

## End-to-End Hello Example

This example proves that Pi wrote to Drive9 rather than to a same-named host
path. It does not require the Drive9 CLI.

```bash
# Start Pi in the local project
cd ./my-project
pi
```

Set up the root and then ask Pi:

```text
/drive9 setup /workspaces/my-project

Use the write tool to write exactly "hello from Pi\n" to hello.txt,
then use the read tool to confirm it.
```

Verify through the extension:

```text
/drive9 verify write
```

If the Drive9 CLI is already installed, `drive9 fs cat
:/workspaces/my-project/hello.txt` provides an optional independent check.

## Manage or Remove the Package

Use Pi's standard package commands rather than editing settings by hand:

```bash
pi list                              # show installed package sources
pi config                            # enable/disable personal resources
pi config -l                         # configure trusted project resources
pi remove npm:@drive9/drive9-pi      # personal npm install
pi remove -l npm:@drive9/drive9-pi   # project npm install
```

For a Git install, pass its original `git:github.com/drive9-ai/drive9-pi`
source to `pi remove` instead.
`/drive9 disable` keeps the package installed and only turns off Drive9 for the
project. `pi config` controls whether Pi loads the package resource, while
`pi remove` removes the package registration.

## Storage-Only Boundary

When Drive9 is active, the extension replaces Pi's filesystem tools with the
official coding-agent tool factories and their standard schemas and result
shapes:

- `read`, `write`, and `edit` use Drive9 SDK operations;
- `ls` is Pi's canonical directory-listing tool backed by Drive9;
- relative paths resolve from the selected Drive9 root;
- the system prompt identifies the Drive9 workspace.

Drive9 is storage, not compute. In Drive9 mode, model `bash`, `grep`, and `find`
calls fail closed instead of operating on a different host filesystem. The
extension also registers a refusal handler for interactive `!` commands; the
Pi interceptor-order limitation is described below. Applications that need a
shared filesystem and process world must provide a separate sandbox or mount
bridge; this package never pretends a local process can open an SDK-only
Drive9 path. A requested but unavailable Drive9 root also fails closed and
never resumes local model-tool access.

### Extension Composition and Load Order

Drive9 uses Pi's standard same-name tool override mechanism for `read`,
`write`, `edit`, and `ls`. Pi owns tool-conflict diagnostics and precedence:
built-in override warnings are expected, and when two extensions register the
same tool name, extension load order determines the winner. Treat a conflict
involving those four tools as unsafe; disable the competing extension or
arrange for Drive9 to be the winning owner before using Drive9 mode. Drive9
also removes model process tools from the active set and blocks them at the
tool-call boundary while its remote filesystem is active.

Interactive `!` commands use Pi's `user_bash` interceptor chain rather than the
tool registry. The first interceptor that returns operations wins, so an
earlier-loaded shell/SSH/sandbox extension can prevent Drive9's storage-only
refusal from running. Pi does not expose effective `user_bash` ownership to an
extension, so Drive9 cannot verify or enforce that ordering. Load Drive9 before
other `user_bash` interceptors, or do not use interactive `!` commands in that
composition. Treat `!` as an explicit user-controlled host escape hatch, not
part of the Drive9 model-tool isolation boundary. Pi's normal tool-name
conflict diagnostics do not detect this event-handler ordering limitation.

## Programmatic Coding-Agent Integration

Pi extensions that need explicit configuration can reuse the same extension
factory:

```ts
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Client } from "drive9";
import { createDrive9PiExtension } from "@drive9/drive9-pi";

const extension: ExtensionFactory = createDrive9PiExtension({
  defaultRoot: "/workspaces/my-project",
  createClient: () => Client.defaultClient(),
});

export default extension;
```

For lower-level composition, `createDrive9CodingAgentTools` returns Pi's
official `read`, `write`, `edit`, `ls`, and `bash` definitions. The bash
definition is intentionally storage-only and returns an error; it never starts
a host process. The remote edit tool explicitly overrides Pi's local-filesystem
preview with a neutral Drive9-safe renderer so the TUI cannot fall back to a
built-in renderer that reads a same-named host file. Custom hosts that register
only these definitions must also block any separately enabled local `grep` and
`find` execution. They must decide explicitly how to handle interactive `!`;
`createDrive9PiExtension` registers a refusal handler, subject to Pi's
first-interceptor-wins composition behavior.

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
import { createDrive9PiIntegration } from "@drive9/drive9-pi";

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
import { Drive9FileSystem } from "@drive9/drive9-pi";

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

### Pi durable state storage (single-coordinator preview)

`openDrive9SingleCoordinatorStorage()` runs Pi 1.0's portable `JsonlStorage`
on an existing, dedicated Drive9 state directory. The caller must explicitly select
`coordination: "externally-exclusive"` and keep that root exclusive for the
entire storage lifetime:

```ts
import { Client } from "drive9";
import { openDrive9SingleCoordinatorStorage } from "@drive9/drive9-pi";

const storage = await openDrive9SingleCoordinatorStorage(
  {
    client: Client.defaultClient(),
    stateRoot: "/.drive9-pi/sessions/session-42/state",
    coordination: "externally-exclusive",
  },
  context,
);
```

This adapter passes Pi's `StorageConformance` suite and can recover committed
JSONL state after reopening the same namespace. It is not a lease or a stale
writer fence: it provides no automatic expiry takeover, permits no concurrent
session writers, and is rejected by stable Drive9 publication mode. Use
`storageProfile()` to inspect that machine-readable
`single-coordinator-preview` classification. A stable multi-process adapter
still requires a server-enforced writer epoch on every Pi storage commit.
Because this SDK/HTTP profile exposes no public truncate-to-N primitive (the
Drive9 server can truncate to any length over a FUSE mount, but that is a
separate ExecutionEnv), a process crash that leaves a partial JSONL tail after
earlier committed records fails closed on reopen and can require operator
repair; this preview does not promise automatic crash-tail recovery.

### SDK execution environment (preview)

`Drive9SdkExecutionEnv` exposes the same Drive9 filesystem namespace through
Pi 1.0's `ExecutionEnv` contract for file-only agents. Its `exec()` method
always returns `shell_unavailable`; it never starts or falls back to a host
process, even when callers provide a working directory, environment variables,
or output callback.

Repository maintainers can run the required-mode acknowledgement gate against
an authenticated real Drive9 backend:

```bash
DRIVE9_E2E_REQUIRED=1 node --import tsx e2e/sdk-durability-crossproc.ts
```

The gate performs binary `writeFile`, `appendFile`, and `flushFile` operations,
then immediately launches a fresh Node process with its own Drive9 client for
each boundary. Each child performs one read without a visibility sleep or retry
and must observe the exact acknowledged bytes. Cleanup removes and verifies the
unique remote test root.

Passing this gate proves acknowledgement visibility for the tested SDK/server
path. The environment remains preview because this adapter's SDK/HTTP profile
exposes no public truncate-to-N primitive (the Drive9 server itself can truncate
to any length over a FUSE mount, but that is a separate ExecutionEnv) and the
package-wide stable durable runtime still requires a server-enforced state-writer
epoch. Use it only when an unavailable shell is the intended execution policy.

## LayerFS workspace backend (preview)

The package also exports `Drive9LayerWorkspaceBackend` as a low-level Pi 1.0
workspace-coordination primitive. It is not used by the default Pi extension
and does not change the live-filesystem semantics of `Drive9FileSystem`.

The backend requires caller-provided `Drive9LayerWorkspaceClient` and
`Drive9LayerBindingStore` implementations. It creates and verifies exact
checkpoints, forks a writable child pinned to the published checkpoint,
detects unpublished layer events, validates deterministic-child lineage, and
switches the conversation binding only through the supplied fenced
compare-and-set operation. Superseded layers are abandoned with a
non-cascading logical delete; this is not physical checkpoint deletion.

This surface is preview. It does not claim mounted quiesce plus checkpoint,
flatten or rebase, checkpoint garbage collection, nonzero truncate, stable
cross-process SDK acknowledgement durability, or a server-enforced writer
epoch. Callers must fail closed when their client or binding store cannot prove
the required checkpoint, lineage, or fencing contract.

Repository maintainers can run the opt-in live recovery gate with an
authenticated Drive9 CLI configuration:

```bash
DRIVE9_E2E_REQUIRED=1 npm run e2e:recovery-crossproc
```

It creates published and later orphan LayerFS generations on the real Drive9
service, runs `recoverWorkspace()`, and launches a second Node process with its
own client connection to verify the recovered bytes and exact checkpoint
lineage. It also forks a Pi child at the first parent publication, advances the
parent to a second publication, and proves that parent and child recover their
different checkpoint-pinned bytes from independent processes. Required mode
fails instead of skipping when the authenticated backend is unavailable, and
the run fails if any created layer remains active after cleanup.

This test uses the real Drive9 SDK methods; it has no raw HTTP fallback. The
LayerFS fork/delete/list methods it exercises ship in the `drive9 ^0.2.0`
dependency, so no overlay or repository-only install is required. The E2E still
uses in-memory Pi Storage in explicit single-coordinator preview mode and
therefore does not prove server-enforced writer-epoch fencing.

### Workspace candidate inventory (preview)

`inspectWorkspaceCandidateInventory()` provides the V1 retention and metering
surface for durable workspace candidates. It coalesces identical duplicate
records and reports each logical candidate as `published`,
`permanently-unpublishable`, or `unresolved`, with counts and a
`requiresAttention` flag suitable for operator alerts. A terminal failed,
aborted, orphaned, or faulted task, an error result, or an unselected candidate
of an immutable terminal success can prove that candidate can never publish.
An active task, a fork-cutoff-hidden result, or incomplete/mismatched evidence
remains unresolved.

`reportWorkspaceCandidateInventory()` sends the same inventory to an explicit
best-effort reporter. Reporter failure is surfaced through `onReportError` but
does not change the returned inventory or workspace publication truth.

This API never deletes a checkpoint, layer, candidate, or evidence object.
`permanently-unpublishable` means only that the owning Pi task can no longer
publish the candidate; it is not proof that no historical fork references its
checkpoint. Candidate inventory also cannot discover a physical checkpoint
created before its candidate record became durable.

A separate `reclaimOrphanLayers` API performs reference-aware orphan *layer* GC:
it reclaims only layers the inventory proved permanently unpublishable and that
no other layer references as a fork parent (reference index built from the full
`listFSLayers()` list), deletes non-cascading, treats a server `still_pins`/409
as still-referenced, and fails closed rather than deleting without that proof.
There is still no reference-aware physical *checkpoint* deletion contract, so
checkpoints without a durable candidate record, and any orphan a pass
conservatively skips, remain retained.

### Conversation workspace lineage (preview)

`createDrive9ConversationCreated()` is a Pi 1.0 `conversationCreated` hook for
durable workspace identity. It creates a rewindable `drive9.workspace`
document for every conversation. A transcript fork receives a new deterministic
workspace ID and records its immediate parent conversation, exact inclusive
entry cutoff, parent workspace ID, and inherited root workspace ID.

The hook performs no Drive9 network provisioning while Pi holds its commit
line. Physical workspace creation remains lazy: the first recovery or mutating
tool resolves the newest published candidate through Pi's fork-visible entries
and forks a writable LayerFS generation from that exact checkpoint. The
document records lineage and supports lookup; it is not publication proof and
must never replace the entry/task/checkpoint publication predicate. The V1
document intentionally contains no checkpoint or reconciled-head field.

```ts
const harness = await Harness.open(
  storage,
  {
    models,
    registry,
    conversationCreated: createDrive9ConversationCreated({ sessionId }),
  },
  context,
);
```

### Pi 1.0 durable composition (preview)

The package root exports the Pi 1.0 composition units; callers do not need
private `src/` or `dist/` imports:

```ts
import {
  createDrive9DurableExtension,
  createDrive9WorkspaceCoordinator,
} from "@drive9/drive9-pi";

const coordinator = createDrive9WorkspaceCoordinator({
  sessionId,
  storage,
  backend,
  initialCheckpoint,
  maxLayerDepth: 8,
  mode: {
    kind: "single-coordinator-preview",
    writerEpoch,
  },
});

registry.install(createDrive9DurableExtension({ coordinator }));
```

`createDrive9DurableExtension()` wraps Pi's native `write`, `edit`, and `bash`
tools; it does not register duplicate implementations. Custom tools can use
`withDrive9Effects()` with an explicit effect classification. The root API also
exports the coordinator/backend contracts, protocol error type, workspace
generation/checkpoint types, and preview recovery mode needed for typed
composition.

The stable writer marker is intentionally not public. A caller cannot promote
generic Pi `Storage` by assertion; stable mode remains reserved for a future
package-owned adapter whose write path actually enforces the writer epoch on
every commit. The public Pi 1.0 peer contract pins `pi-durable` and Chord to the
exact reviewed `1.0.0` versions.

The test suite includes a deterministic T0–T7 protocol crash matrix. It proves
that incomplete attempts, dirty generations, orphan checkpoints, and orphan
candidates never become the next mutation's baseline; a terminal success with
no matching durable candidate fails closed; and tool success cannot become
visible before candidate commit acknowledgement. This is a state-machine test,
not proof of Drive9 transport durability. Stable SDK publication remains gated
on the separate real-backend, another-process recovery tests described above.

## Evidence API

`PersistentToolResultStore` stores immutable output chunks and publishes a
stable reference only after a CAS-protected terminal manifest is durable.

```ts
import { createDrive9ResultStore } from "@drive9/drive9-pi";

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
