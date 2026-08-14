# Pi × Drive9 Design Lock

## 1. V1 Product Contract

Drive9 provides two capabilities to Pi:

1. a durable SDK-backed filesystem;
2. a durable tool-result evidence store.

Drive9 does not provide compute, a shell, a sandbox, a process runner, FUSE,
or a general-purpose `ExecutionEnv` compositor. `createDrive9PiIntegration`
binds Pi's read/write/edit/list tools to a private file-only environment, installs
the evidence tools and fallback, and returns complete `AgentOptions` through
`withAgentOptions`. Its environment rejects `exec` unless the caller supplies
a `Shell`; explicit additional Pi harness tools can then use only that shell.
The package never creates or falls back to a host shell. The application
continues to own execution.

V1 deliberately does not use LayerFS. `Drive9FileSystem` mutates the live
Drive9 filesystem through ordinary SDK methods and does not expose a `layerId`,
checkpoint, branch, commit, or rollback contract. LayerFS may be added later as
a separate optional adapter after a concrete product workflow requires it.

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

### 2.2 Explicit Non-Goals

- no active layer creation;
- no workspace checkpoint or rollback;
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
- No FUSE, WebDAV, LayerFS, or mount requirement for filesystem operations.
- Path escape is rejected before a client method is called.
- URL delimiters, percent escapes, controls, malformed Unicode, and backslashes
  that could change the locked SDK's request target are rejected consistently
  for workspace, evidence-store, and evidence-isolation paths.
- Workspace and evidence roots must be disjoint.
- A missing object is not accepted as proof of authorization denial.
- Backend exceptions map to stable `FileError` or `ResultStoreError` codes.
- Cleanup is best-effort and removes only temporary paths created by the
  adapter instance.

## 5. Pi Integration Preset

`createDrive9PiIntegration` is the default customer entrypoint. It:

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

1. the public package exports a one-call Pi integration preset but no
   Drive9-owned exec tool, public execution class, `composeExecutionEnv`, or
   LayerFS workspace provider;
2. `Drive9FileSystem` uses only ordinary Drive9 SDK filesystem operations and
   imports no local filesystem, host execution, or LayerFS API;
3. path escape and root mutation fail before backend side effects;
4. write, append, list, stat, rename, mkdir, non-recursive delete, recursive
   delete, temp allocation, and cleanup have discriminating tests;
5. missing paths, authorization failures, aborts, malformed backend entries,
   directories, and symlinks map to explicit Pi results;
6. evidence isolation, CAS finalization, crash recovery, and bounded reads
   remain covered;
7. a real Pi `Agent` loop proves model-issued read/write/edit/list calls reach the
   Drive9 filesystem and oversized output is retrieved with the evidence tools;
8. the preset composes existing tools and `afterToolCall` hooks, rejects
   ambiguous duplicates/session scope, installs no shell tool by default, and
   delegates explicit harness tools only to a supplied shell;
9. README and demo lead with the one-call integration without claiming shell
   execution, branch, checkpoint, or rollback semantics.
