# Pi × Drive9 Design Lock

This document locks two separate surfaces. The existing Pi 0.x-compatible
extension and live-filesystem adapter remain the default public path. The Pi
1.0 LayerFS workspace backend is an explicit low-level preview surface; it does
not change the default extension or promote the missing durability primitives
listed below to stable support.

## 1. Product Contract

The default Pi 0.x-compatible extension provides two capabilities:

1. a durable SDK-backed filesystem;
2. a durable tool-result evidence store.

Drive9 does not provide compute, a shell, a sandbox, a process runner, FUSE,
or a general-purpose `ExecutionEnv` compositor. The primary customer entrypoint
is a standard Pi package extension. It replaces Pi coding-agent filesystem
operations with Drive9 operations while users keep the ordinary `pi` install
and startup flow. In Drive9 mode, host process tools fail closed rather than
operating in a different filesystem world.

`createDrive9PiIntegration` remains a lower-level agent-core preset. It binds
Pi's harness read/write/edit/list tools to a private file-only environment,
installs the evidence tools and fallback, and returns complete `AgentOptions`
through `withAgentOptions`. Its environment rejects `exec` unless the caller
supplies a `Shell`; explicit additional harness tools can then use only that
shell. The package never creates or falls back to a host shell. The application
continues to own execution.

The default extension deliberately does not use LayerFS. `Drive9FileSystem`
mutates the live Drive9 filesystem through ordinary SDK methods and does not
expose a `layerId`, checkpoint, branch, commit, or rollback contract.

Pi 1.0 durable workspace coordination is a separate preview surface. The
package exports `Drive9LayerWorkspaceBackend` for a caller that supplies both a
LayerFS client and a fenced binding store. This backend does not replace
`Drive9FileSystem`, and it is not activated by the default Pi extension.

### 1.1 Pi 1.0 LayerFS Preview Contract

The preview backend implements restore-by-fork rather than in-place rollback:

1. create and independently read an exact checkpoint;
2. re-read the published source checkpoint before recovery;
3. fork a deterministic writable child pinned to that checkpoint;
4. accept an existing child only when its root, parent, checkpoint, and depth
   exactly match the requested lineage;
5. detect unpublished writes from layer-local events;
6. switch the conversation binding only through a caller-supplied fenced
   compare-and-set operation and verify its receipt; and
7. abandon superseded layers with non-cascading logical delete.

The backend never treats the latest physical checkpoint as published truth,
never rolls a dirty child forward, and never describes logical abandon as
physical checkpoint deletion.

This surface remains preview until the surrounding runtime proves all required
durability and fencing contracts. In particular, it does not claim:

- atomic mounted quiesce plus checkpoint;
- stable direct-SDK acknowledgement durability across another process;
- flatten or rebase for bounded LayerFS depth;
- checkpoint deletion or orphan garbage collection;
- nonzero truncate support; or
- a storage implementation with a server-enforced writer epoch.

## 2. `Drive9FileSystem`

`Drive9FileSystem implements FileSystem` using the ordinary Drive9 SDK. It
imports no local filesystem or execution implementation and requires no mount.

The filesystem has one absolute POSIX `root` and one `cwd` contained by that
root. Every addressed path is normalized and checked against `root` before a
backend call. Expected and unexpected backend failures are returned as
`FileError`; operation methods never reject.

### 2.1 Capability Matrix

| Pi capability | Drive9 SDK primitive | Required behavior |
| --- | --- | --- |
| read text/binary | `stat`, `read`, `readStream` | reject directories and unsupported symlink reads; stop bounded line reads early |
| write | `write` | create missing parent directories; reject root and symlink overwrite |
| append | `append` | create missing parent directories; preserve SDK append concurrency contract |
| file info | `stat` | return addressed path, kind, size, and modification time |
| list directory | `stat`, `list` | validate direct child names and sort deterministically |
| rename | `rename` | use the server atomic rename operation; never copy-plus-delete |
| mkdir | `stat`, `mkdir` | recursive parent-first creation; existing directory is success |
| remove | `deleteFile`, `deleteDir`, `removeAll` | support force, non-recursive empty-directory checks, and recursive removal |
| temp file/dir | `createFile`, `mkdir`, delete APIs | allocate exclusively under `tempRoot`; retain failed cleanup for retry |
| canonical path | `stat` | return normalized non-symlink path; symlink resolution is unsupported |

Mutations issued through one adapter instance are serialized. This avoids
adapter-local ordering races but is not a distributed transaction or a global
workspace snapshot.

The configured root itself cannot be overwritten, renamed, or removed.
Cross-root path traversal is rejected before any SDK call.
Paths are normalized to Drive9's NFC namespace before containment and canonical
identity checks. Characters that the locked Drive9 SDK cannot safely preserve
through URL construction fail closed before a client method is called.

### 2.2 `Drive9FileSystem` Explicit Non-Goals

- no active layer creation through this adapter;
- no workspace checkpoint or rollback through this adapter;
- no transparent capture of arbitrary shell side effects;
- no host shell fallback;
- no local mirror or mount lifecycle.

## 3. Tool Result Evidence

`PersistentToolResultStore` and `Drive9ResultStoreBackend` retain the immutable
chunk plus CAS-terminal-manifest protocol. Tool output is persisted before a
stable result reference is published to the model.

The package exposes bounded `result_read` and `result_search` tools plus an
`afterToolCall` fallback for oversized text results. It does not expose a
command-execution tool or capture a LayerFS checkpoint. The fallback excludes
`result_read` and `result_search` so evidence retrieval cannot recursively
produce another evidence reference.

`afterToolCall` runs after a tool has materialized its result; it is a safety
fallback, not an unbounded streaming writer. Callers with streaming output
must append chunks through `ToolResultStore` before publishing the reference.

## 4. Security and Failure Rules

- No built-in shell, host environment inheritance, or implicit local process.
- No FUSE, WebDAV, LayerFS, or mount requirement for `Drive9FileSystem`
  operations. The separate preview workspace backend requires LayerFS by
  definition.
- Path escape is rejected before a client method is called.
- URL delimiters, percent escapes, controls, malformed Unicode, and backslashes
  that could change the locked SDK's request target are rejected consistently
  for workspace, evidence-store, and evidence-isolation paths.
- Workspace and evidence roots must be disjoint.
- A missing object is not accepted as proof of authorization denial.
- Backend exceptions map to stable `FileError` or `ResultStoreError` codes.
- Cleanup is best-effort and removes only temporary paths created by the
  adapter instance.

## 5. Pi Package and Integration Preset

The package manifest declares a Pi extension and the `pi-package` keyword. The
extension resolves activation in this order: `--no-drive9`, `--drive9-root`,
`DRIVE9_PI_ROOT`, trusted project configuration, and an explicit programmatic
default. Project configuration is stored in `.pi/drive9.json`; it is read only
when Pi reports the project trusted and the project contains the standard
`.pi/settings.json` trust marker. Interactive `/drive9 setup` preserves an
existing settings file or creates a minimal marker before atomically writing
the non-secret Drive9 configuration. When active, the extension uses
`Client.defaultClient()` and Pi coding-agent's official tool factories:

- `read`, `write`, and `edit` delegate to Drive9 filesystem operations;
- Pi's canonical `ls` tool delegates to Drive9 directory operations;
- the edit call renderer cannot read a same-named local file;
- model bash/grep/find fail closed, and the extension's `user_bash` handler
  refuses interactive shell execution when Pi selects that handler;
- the system prompt identifies the Drive9 root and storage-only boundary;
- a missing, invalid, non-directory, or tenant root fails closed and cannot
  silently resume local filesystem access;
- the effective read/write/edit/ls registrations are verified during activation;
  a conflicting filesystem extension makes Drive9 unavailable instead of
  silently routing a standard tool somewhere else;
- interactive `!` is outside the verifiable model-tool boundary because Pi
  selects the first `user_bash` interceptor and exposes no effective-owner
  query. The extension documents this composition limit and never claims that
  its refusal handler can override an earlier interceptor.

The extension exposes `/drive9 setup`, `/drive9 status`, `/drive9 disable`, and
`/drive9 verify [write]`, plus `--drive9-root` and `--no-drive9` for one-shot
use. Its footer distinguishes inactive, checking, active, disabled, and
unavailable states. When Drive9 is checking or unavailable, standard
filesystem and process tools are removed from the active tool set and blocked
at the tool-call boundary. Pi reports lifecycle handler exceptions rather than
propagating them, so an exception alone is never treated as the safety
mechanism.

This is the default public usage. It follows Pi's package and remote-operation
extension pattern instead of requiring users to construct a custom `Agent`.

`createDrive9PiIntegration` is the lower-level agent-core entrypoint. It:

- constructs the workspace filesystem and evidence store;
- binds Pi's built-in `read`, `write`, and `edit` tools plus a direct-child
  `list` tool to Drive9;
- installs `result_read` and `result_search` in the same session scope;
- installs the oversized-result fallback after any existing application hook;
- rejects duplicate tool names and a conflicting Agent session ID;
- registers no `exec` or `bash` tool by default and never uses a host shell;
- optionally binds explicit caller-selected harness tools to a caller-supplied
  `Shell`, with Drive9 as their filesystem view.

The lower-level filesystem, store, and adapter factories remain available for
applications that need custom composition.

## 6. Acceptance Gates

A releasable head must prove:

1. the package installs through Pi's standard package manifest, uses the
   official coding-agent filesystem tool factories, and preserves ordinary Pi
   startup while exporting a lower-level integration preset;
2. `Drive9FileSystem` uses only ordinary Drive9 SDK filesystem operations and
   imports no local filesystem, host execution, or LayerFS API;
3. path escape and root mutation fail before backend side effects;
4. write, append, list, stat, rename, mkdir, non-recursive delete, recursive
   delete, temp allocation, and cleanup have discriminating tests;
5. missing paths, authorization failures, aborts, malformed backend entries,
   directories, and symlinks map to explicit Pi results;
6. evidence isolation, CAS finalization, crash recovery, and bounded reads
   remain covered;
7. usage-level tests prove coding-agent read/write/edit/ls calls reach Drive9,
   remote edit rendering does not touch local files, and process tools cannot
   fall through to the host;
8. the preset composes existing tools and `afterToolCall` hooks, rejects
   ambiguous duplicates/session scope, installs no shell tool by default, and
   delegates explicit harness tools only to a supplied shell;
9. README leads with a currently usable standard `pi install` path, setup and
   one-shot configuration, provides copyable SDK configuration, and does not
   claim shell execution, branch, checkpoint, or rollback semantics for the
   default extension or `Drive9FileSystem`;
10. trusted project configuration, command-driven setup/status/disable/verify,
    footer state, tool ownership conflicts, active-tool selection, headless
    fail-closed behavior, package build output, and a real Pi Git install have
    discriminating regression coverage;
11. the preview LayerFS backend verifies exact checkpoint identity and lineage,
    rejects dirty or mismatched recovery children, reconciles only exact
    deterministic-create conflicts, validates fenced binding receipts, uses
    non-cascading logical abandon, and keeps generated layer IDs within the
    server contract.
