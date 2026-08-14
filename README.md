# drive9-pi

Drive9 filesystem and durable tool-result evidence integration for Pi.

The normative contract is [`docs/design-lock.md`](docs/design-lock.md).

## Install

The currently available installation path is Git:

```bash
# Personal install: recorded in ~/.pi/agent/settings.json
pi install git:github.com/drive9-ai/drive9-pi

# Team/project install: recorded in .pi/settings.json
pi install -l git:github.com/drive9-ai/drive9-pi
git add .pi/settings.json
```

The npm package has not been published yet. After it is published, the
equivalent personal and project installs will be:

```bash
pi install npm:@drive9-ai/drive9-pi
pi install -l npm:@drive9-ai/drive9-pi
```

After a teammate trusts the project, Pi installs a missing project package on
startup. Pi packages execute code with the permissions of the Pi process, so
review packages before trusting them. Git sources can use Pi's normal
`@tag-or-commit` suffix when a pinned revision is required.

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

Create the Drive9 directory first, then run the interactive setup from the
local project that should use it:

```bash
drive9 fs mkdir :/workspaces/my-project
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
the root is missing, setup can create it after confirmation when its parent
directory already exists.

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
path. Drive9 CLI paths use the `:/...` form; the Pi extension root uses `/...`
without the colon.

```bash
# Terminal 1: authenticate as shown above and create the remote root once
drive9 fs mkdir :/workspaces/my-project

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

Verify from another terminal, outside Pi:

```bash
drive9 fs cat :/workspaces/my-project/hello.txt
# hello from Pi
```

## Manage or Remove the Package

Use Pi's standard package commands rather than editing settings by hand:

```bash
pi list                              # show installed package sources
pi config                            # enable/disable personal resources
pi config -l                         # configure trusted project resources
pi remove git:github.com/drive9-ai/drive9-pi    # personal Git install
pi remove -l git:github.com/drive9-ai/drive9-pi # project Git install
```

After an npm release, pass `npm:@drive9-ai/drive9-pi` to `pi remove` instead.
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
