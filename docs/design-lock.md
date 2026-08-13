# Pi × Drive9 Design Lock

## 1. V1 Product Contract

Drive9 provides two capabilities to Pi:

1. a durable SDK-backed filesystem;
2. a durable tool-result evidence store.

Drive9 does not provide compute, a shell, a sandbox, a process runner, FUSE,
or a Pi `ExecutionEnv` compositor. The application owns execution and composes
its own Pi environment.

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
| read text/binary | `stat`, `read` | reject directories and unsupported symlink reads |
| write | `write` | create missing parent directories; reject root and symlink overwrite |
| append | `append` | create missing parent directories; preserve SDK append concurrency contract |
| file info | `stat` | return addressed path, kind, size, and modification time |
| list directory | `stat`, `list` | validate direct child names and sort deterministically |
| rename | `rename` | use the server atomic rename operation; never copy-plus-delete |
| mkdir | `stat`, `mkdir` | recursive parent-first creation; existing directory is success |
| remove | `deleteFile`, `deleteDir`, `removeAll` | support force, non-recursive empty-directory checks, and recursive removal |
| temp file/dir | ordinary write/mkdir/delete APIs | allocate under `tempRoot`; cleanup only adapter-owned paths |
| canonical path | `stat` | return normalized non-symlink path; symlink resolution is unsupported |

Mutations issued through one adapter instance are serialized. This avoids
adapter-local ordering races but is not a distributed transaction or a global
workspace snapshot.

The configured root itself cannot be overwritten, renamed, or removed.
Cross-root path traversal is rejected before any SDK call.

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
command-execution tool or capture a LayerFS checkpoint.

`afterToolCall` runs after a tool has materialized its result; it is a safety
fallback, not an unbounded streaming writer. Callers with streaming output
must append chunks through `ToolResultStore` before publishing the reference.

## 4. Security and Failure Rules

- No built-in shell, host environment inheritance, or implicit local process.
- No FUSE, WebDAV, LayerFS, or mount requirement for filesystem operations.
- Path escape is rejected before a client method is called.
- Workspace and evidence roots must be disjoint.
- A missing object is not accepted as proof of authorization denial.
- Backend exceptions map to stable `FileError` or `ResultStoreError` codes.
- Cleanup is best-effort and removes only temporary paths created by the
  adapter instance.

## 5. Acceptance Gates

A releasable head must prove:

1. the public package exports no Drive9-owned exec tool, execution class,
   `composeExecutionEnv`, or LayerFS workspace provider;
2. `Drive9FileSystem` uses only ordinary Drive9 SDK filesystem operations and
   imports no local filesystem, host execution, or LayerFS API;
3. path escape and root mutation fail before backend side effects;
4. write, append, list, stat, rename, mkdir, non-recursive delete, recursive
   delete, temp allocation, and cleanup have discriminating tests;
5. missing paths, authorization failures, aborts, malformed backend entries,
   directories, and symlinks map to explicit Pi results;
6. evidence isolation, CAS finalization, crash recovery, and bounded reads
   remain covered;
7. README and demo describe live SDK filesystem mutation without claiming
   shell execution, branch, checkpoint, or rollback semantics.
