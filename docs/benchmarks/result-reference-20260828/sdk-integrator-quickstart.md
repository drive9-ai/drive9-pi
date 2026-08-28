# Drive9 Pi Result References: SDK Integrator Quickstart

This is the current path for teams that already embed Pi Agent SDK and want
large all-text tool results stored as Drive9 references today.

The ordinary Pi package extension currently gives users a Drive9-backed
workspace. Automatic result references for ordinary Pi users should ship as a
separate extension evidence-mode upgrade.

## What The Integrator Provides

Create or pass these values from your agent runtime:

- `workspaceClient`: Drive9 client for the workspace filesystem.
- `workspaceRoot`: Drive9 path where the agent reads and writes project files.
- `evidenceClient`: Drive9 client for durable tool-result evidence.
- `evidenceRoot`: Drive9 path reserved for result chunks and manifests.
- `sessionId`: stable Pi session id.
- `runId`: stable run id inside the session.

Use separate scoped Drive9 credentials for workspace and evidence when
possible. Keep `workspaceRoot` and `evidenceRoot` disjoint, for example:

```text
workspaceRoot = /workspaces/acme/app
evidenceRoot  = /evidence/pi/session-20260828-001
```

`runId` should be stable when resuming the same run and different for a new
run. Reusing the same `sessionId + runId + toolCallId` identity for unrelated
work can alias old evidence.

## Minimal Integration

Install the package in the application that constructs the Pi agent:

```bash
npm install @drive9/drive9-pi drive9
```

Wrap the existing `AgentOptions` once:

```ts
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Client } from "drive9";
import { Type } from "typebox";
import {
  createDrive9PiIntegration,
  verifyEvidenceIsolation,
} from "@drive9/drive9-pi";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const workspaceRoot = required("DRIVE9_WORKSPACE_ROOT");
const evidenceRoot = required("DRIVE9_EVIDENCE_ROOT");
const workspaceClient = Client.defaultClient();
const evidenceClient = new Client(
  required("DRIVE9_EVIDENCE_SERVER"),
  required("DRIVE9_EVIDENCE_API_KEY"),
);

await verifyEvidenceIsolation({
  workspaceRemoteRoot: workspaceRoot,
  evidenceRemoteRoot: evidenceRoot,
  workspaceClient,
  evidenceClient,
});

const drive9 = createDrive9PiIntegration({
  workspaceClient,
  workspaceRoot,
  evidenceClient,
  evidenceRoot,
  sessionId: required("PI_SESSION_ID"),
  runId: required("PI_RUN_ID"),

  // Optional. Current implementation defaults:
  // thresholdBytes: 50 * 1024,
  // previewBytes: 8 * 1024,
});

const agent = new Agent(
  drive9.withAgentOptions({
    streamFn,
    initialState: {
      model,
      // Keep only application-specific tools here. If the application already
      // registers read/write/edit/list/result_read/result_search, remove or
      // rename those tools before calling withAgentOptions().
      tools: applicationTools,
    },
    afterToolCall: applicationAfterToolCall,
  }),
);

try {
  await agent.prompt("Start the task.");
  await agent.continue();
} finally {
  await drive9.cleanup();
}
```

`withAgentOptions()` keeps non-conflicting application tools and chains the
application's existing `afterToolCall` hook. It adds Drive9 file tools,
`result_search`, `result_read`, and the large-result fallback. Duplicate tool
names and a mismatched `AgentOptions.sessionId` fail during setup instead of
silently shadowing another tool.

The benchmark in this directory configured `previewBytes: 2 * 1024` so the
charts have a stable 2 KB reference line. That is a benchmark setting, not the
package default.

## Runtime Behavior

Small tool results stay inline.

Oversized all-text model-visible tool results are written to Drive9 evidence
storage. The model-visible tool result is replaced by a compact reference that
contains the result id, size, line count, status, hash, and a small preview.

When the agent needs details later, it calls:

- `result_search`: find matching lines in the stored result.
- `result_read`: read a bounded line window from the stored result.

Those fetched snippets enter context as ordinary small tool results. The full
original text body does not get copied back into context.

Current fallback scope:

- only all-text `content` is offloaded;
- tool results containing non-text parts are left unchanged;
- `details` are not stored as the evidence body;
- tools that stream very large output should eventually write directly to
  `ToolResultStore` instead of waiting for the whole result to materialize.

## Deterministic Smoke Tool

For a reproducible smoke test, add one deterministic application tool:

```ts
const marker = "DRIVE9_RESULT_REFERENCE_MARKER";
const largeOutputTool: AgentTool = {
  name: "large_output",
  label: "Large Output",
  description: "Return a deterministic large text result for evidence testing.",
  parameters: Type.Object({}, { additionalProperties: false }),
  execute: async () => ({
    content: [
      {
        type: "text",
        text: `${Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join("\n")}\n${marker}\n`,
      },
    ],
    details: undefined,
  }),
};
```

Include it in `applicationTools`, then ask the agent to call `large_output`,
search for `DRIVE9_RESULT_REFERENCE_MARKER`, and read the matching line window.

Expected behavior:

1. The model-visible result from `large_output` is a compact Drive9 reference,
   not the full log.
2. The marker is not present in the reference preview.
3. `result_search` can find `DRIVE9_RESULT_REFERENCE_MARKER`.
4. `result_read` can read the nearby line window.
5. A different session cannot read the result.

A scripted harness can additionally assert stable replay behavior for the same
tool-call identity. Do not rely on an ordinary prompt to reproduce a specific
tool-call id.

## What To Say Publicly

Accurate wording today:

> SDK teams can use `createDrive9PiIntegration(...).withAgentOptions(...)` to
> keep large all-text Pi tool results as Drive9 references and fetch only the
> snippets the agent needs with `result_search` / `result_read`.

Avoid saying:

- The current public Pi extension automatically enables result references for
  ordinary users.
- Drive9 is the agent runtime, shell, or sandbox.
- The model can reason over the full stored result without fetching relevant
  snippets.
- The benchmark proves model success rate or provider-billed token cost.

## Ordinary Pi User Follow-Up

The product-grade ordinary-user path should be an extension evidence mode:

```bash
pi install npm:@drive9/drive9-pi
pi
/drive9 setup /workspaces/my-project
/drive9 evidence on
/drive9 verify evidence
```

The last two commands are the recommended next product entrypoint; they are not
part of the current public `0.1.0` package.
