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

## Drive9 evidence backend

`Drive9ResultStoreBackend` maps the three-method store contract to Drive9
revision CAS. It confines every object to one absolute evidence root and uses
bounded `stat -> read -> stat` stabilization because the current Drive9
JavaScript SDK does not expose a revision-pinned read.

```ts
import { Client } from "drive9";
import { createDrive9ResultStore } from "@drive9-ai/drive9-pi";

const evidenceClient = new Client(baseUrl, evidenceScopedApiKey);
const results = createDrive9ResultStore({
  client: evidenceClient,
  evidenceRoot: "/agent-evidence/run-123",
});
```

The evidence client must use a credential that is not mounted into or exposed
to the agent workspace. `verifyEvidenceIsolation` is a fail-closed startup
probe: it rejects overlapping roots and a mismatched mount root, proves the
evidence client can create/read/replace/delete a randomized object, and
requires the workspace credential to receive an explicit 401/403 for read,
write, and delete on that object.

## Pi adapters

`createDrive9ExecTool` streams stdout and stderr into durable chunks, finalizes
the result, and only then returns an at-most-8-KiB reference. A pre-existing
writing attempt is marked `unknown` and a new attempt must be allocated before
the command can spawn. Pending evidence is bounded; exhaustion or persistence
failure aborts the command rather than returning false `completed` evidence.

```ts
import {
  createAfterToolCallFallback,
  createDrive9ExecTool,
  createResultReadTool,
  createResultSearchTool,
} from "@drive9-ai/drive9-pi";

const drive9Exec = createDrive9ExecTool({
  env,
  store: results,
  allocateIdentity,
  workspaceRevisionProvider,
  commandEnvironment: { PATH: "/usr/local/bin:/usr/bin:/bin" },
});

const tools = [
  drive9Exec,
  createResultReadTool({ store: results, currentSessionId }),
  createResultSearchTool({ store: results, currentSessionId }),
];

const afterToolCall = createAfterToolCallFallback({
  store: results,
  allocateIdentity,
  workspaceRevisionProvider,
});
```

`drive9_exec` does not inherit the host environment by default. Supply only
the command variables it needs through `commandEnvironment`. Setting
`inheritEnvironment: true` is an explicit weakening; the host must first prove
that no evidence credential or other integration secret is ambient.

The fallback offloads all-text tool content only when it exceeds 50 KiB.
`result_read` and `result_search` enforce the current session identity before
returning bounded model-visible pages. Images remain out of P0.

## LayerFS binding

`Drive9LayerWorkspaceRevisionProvider` runs a required drain callback before
creating a LayerFS checkpoint. `createDrive9MountDrain` supplies the real
`drive9 mount drain` barrier; its default child environment excludes HOME,
configuration discovery paths, and Drive9 credentials. The resulting layer
ID, durable sequence, checkpoint ID, and capture time are provenance
observations, not an isolated snapshot.

## Real acceptance demo

`npm run demo:drive9` is the destructive P0 acceptance demo. Run it only with a
dedicated LayerFS layer, mount, evidence prefix, and two prefix-scoped
credentials. Prefer credential files so values never enter shell history:

```sh
export DRIVE9_PI_BASE_URL=https://drive9.example
export DRIVE9_PI_MOUNT=/mnt/drive9-pi-demo
export DRIVE9_PI_WORKSPACE_REMOTE_ROOT=/workspaces/pi-demo
export DRIVE9_PI_MOUNT_REMOTE_ROOT=/workspaces/pi-demo
export DRIVE9_PI_EVIDENCE_REMOTE_ROOT=/evidence/pi-demo
export DRIVE9_PI_LAYER_ID=layer-for-this-demo
export DRIVE9_PI_WORKSPACE_API_KEY_FILE=/run/secrets/workspace-key
export DRIVE9_PI_EVIDENCE_API_KEY_FILE=/run/secrets/evidence-key
npm run demo:drive9
```

The demo uses the real Pi `Agent`, real `drive9_exec`, a failing `npm test`
fixture larger than 50 KiB, bounded search/read tools, mount drain and LayerFS
checkpoints. It verifies terminal objects before Pi emits the tool result,
records manifest/chunk revisions and SHA-256 values, rolls back the layer,
proves evidence bytes and revisions are unchanged, then kills a child after a
durable chunk and recovers the result as explicit `unknown`. Model commands
run with a workspace-private HOME and XDG tree; host Drive9 config and ambient
Drive9 credentials are not inherited. Layer rollback is intentional and makes
this command unsuitable for a shared or valuable layer.
