# Drive9 Pi Result-Reference Evaluation

## Scope

Question: does the Drive9 Pi integration actually keep large all-text model-visible tool results out of the model context while preserving enough recoverability to be useful?

Tested package: `@drive9/drive9-pi` local checkout at `988b80f` (`fix: make public Pi release turnkey`).

Relevant implementation:

- `src/pi-integration.ts:201-245` wires the production `createDrive9PiIntegration(...).withAgentOptions(...)` preset, installing Drive9 file tools, `result_read`, `result_search`, and the `afterToolCall` fallback.
- `src/pi-adapters.ts:236-265` offloads oversized all-text tool results into `ToolResultStore`, finalizes them, then replaces the model-visible result with a compact Drive9 durable-result reference.
- `src/pi-adapters.ts:316-390` exposes bounded `result_read` and `result_search`, guarded by current-session ownership.
- `docs/design-lock.md:73-87` defines this as durable tool-result evidence, not command execution, shell, or sandbox.

The benchmark scripts exercise the real adapter/store/read/search logic with a
local in-memory `ResultStoreBackend`. They do not hit the hosted Drive9 server,
do not measure network persistence, and do not run a full model-in-the-loop task.

## Runs

Commands:

```bash
npx tsx docs/benchmarks/result-reference-20260828/reference-eval.ts
npm install --prefix /tmp/drive9-pi-tokenizer gpt-tokenizer@4.0.0
NODE_PATH=/tmp/drive9-pi-tokenizer/node_modules npx tsx docs/benchmarks/result-reference-20260828/reference-token-bars.ts
npm test
npm run check
npm run build
```

Results:

- Custom evaluation passed.
- Package tests passed: 77/77.
- Typecheck passed.
- Build passed.

## Evaluation Result

Chart files:

- `result-reference-chart.svg`
- `result-reference-chart.png`
- `result-reference-cumulative-chart.svg`
- `result-reference-cumulative-chart.png`
- `result-reference-stats.csv`
- `result-reference-token-peak-bars.svg`
- `result-reference-token-peak-bars.png`
- `result-reference-token-cumulative-bars.svg`
- `result-reference-token-cumulative-bars.png`
- `result-reference-token-bars.csv`
- `result-reference-token-scenarios.json`
- `sdk-integrator-quickstart.md`
- `article-draft.zh.md`

The custom evaluation generated long synthetic tool outputs with answer markers
deliberately placed outside the preview, then exercised the real Drive9 Pi
result fallback and result tools. It configured `thresholdBytes: 4 * 1024` and
`previewBytes: 2 * 1024` for stable charts. The package defaults are
`thresholdBytes: 50 * 1024` and `previewBytes: 8 * 1024`.

| Result size | Model-visible reference | Reduction | `result_search` bytes for 5 facts | `result_read` bytes for 5 pages |
| --- | ---: | ---: | ---: | ---: |
| 73,695 B | 2,048 B | 97.22% | 3,179 B | 5,755 B |
| 1,470,195 B | 2,048 B | 99.86% | 3,205 B | 5,786 B |
| 7,350,195 B | 2,048 B | 99.97% | 3,220 B | 5,805 B |

Other checks:

- Hidden markers outside the preview were absent from the compact model-visible tool result.
- `result_search` found all hidden markers.
- `result_read` retrieved bounded line windows around every marker.
- Replaying the same tool call returned the same stable result id.
- Small tool results stayed inline.
- `result_read` and `result_search` outputs were not recursively offloaded.
- Cross-session reads were denied.

For a concrete context-budget comparison, five 1.47 MB inline tool results would have added about 7.35 MB to the transcript. The reference mode adds about 10 KB for the five compact references before targeted retrieval.

## Token Bar Charts

The token charts use synthetic scenario-shaped fixtures rather than only generic
byte sizes:

1. `go test log`: a generated test-log-shaped fixture with root-cause markers outside preview.
2. `tsc build log`: a generated compiler-output-shaped fixture with file and symbol markers outside preview.
3. `repo-wide rg`: a generated search-result-shaped fixture with useful facts near the tail.
4. `5-round task`: five generated large outputs with facts split across rounds 1, 3, and 5.

Token counts are estimates from `gpt-tokenizer@4.0.0` using the `gpt-4o`
vocabulary. They are useful for relative comparison, but they are not
provider-billed usage. Shared system/user prompt overhead is excluded because it
is common to both modes. A billed-cost or success-rate benchmark should run the
same prompts through one fixed model and record each call's `usage.input_tokens`
and answer quality.

| Scenario | Full inline result | Drive9 reference | Reference + fetched snippets | Completed reference task total | Reduction vs inline |
| --- | ---: | ---: | ---: | ---: | ---: |
| go test log | 324,041 tokens | 535 tokens | 1,923 tokens | 2,458 tokens | 99.41% |
| tsc build log | 216,048 tokens | 515 tokens | 1,890 tokens | 2,405 tokens | 99.13% |
| repo-wide rg | 447,027 tokens | 508 tokens | 1,227 tokens | 1,735 tokens | 99.73% |
| 5-round task | 675,090 tokens | 2,636 tokens | 4,685 tokens | 7,321 tokens | 99.31% |

Use the two token bar charts differently:

- `result-reference-token-peak-bars.*`: peak input-token pressure for the next model request. This is the chart for "will this blow the context window?"
- `result-reference-token-cumulative-bars.*`: task evidence tokens after counting the reference-handle turn plus the answer turn with fetched snippets. This is the chart for "does the reference path still use far fewer input tokens after retrieval?"

"Reference + fetched snippets" means the compact Drive9 result handle plus the exact small slices later returned by `result_search` / `result_read`. It does not include the full original tool output.

## Verdict

This works well for the intended class: large all-text model-visible tool
outputs where the useful signal is sparse and can be pulled back by search or
bounded reads. Logs, test output, build output, generated reports, grep output,
and long diagnostics are strong fits.

It is not magic memory. If the next model turn must reason over the entire output
without issuing retrieval calls, reference mode will not help; the whole point is
that the full body is not in context. It also does not remove the cost of first
materializing a tool result when using the `afterToolCall` fallback. The current
fallback only offloads all-text `content`; non-text parts are left unchanged, and
`details` are not stored as the evidence body. Tools that can stream
stdout/stderr directly into `ToolResultStore` will be the stronger path for very
large or long-running outputs.

The product claim should therefore be:

Drive9 keeps heavy tool output as durable evidence and puts a small citation-like handle in the agent context. The agent can search or page the evidence back when it needs it. This preserves recall without turning every log into prompt ballast.

## Article Draft

The publishable Chinese draft is maintained separately in
`article-draft.zh.md`. It now frames the data as a mechanism benchmark using
synthetic scenario-shaped fixtures and a `MemoryBackend`, not as a real
Drive9-server E2E or model-success benchmark.

## Usage Recommendation

There are two honest entry points today.

For ordinary Pi users who mainly want Drive9-backed files, the current public npm entry is `@drive9/drive9-pi@0.1.0` (`npm latest` checked on 2026-08-28):

```bash
pi install npm:@drive9/drive9-pi
export DRIVE9_SERVER="https://api.drive9.ai"
export DRIVE9_API_KEY="d9_..."
cd ./my-project
pi
/drive9 setup /workspaces/my-project
/drive9 verify write
```

This activates the package extension and routes Pi's `read` / `write` / `edit` / `ls` tools to Drive9. It does not make Drive9 the runtime or shell.

For application teams embedding Pi Agent SDK and wanting result references now:

See `sdk-integrator-quickstart.md` for the copyable integration checklist. It
includes `verifyEvidenceIsolation()`, the correct `Agent.prompt()` API, the
current 50KB/8KB defaults, `runId` lifecycle guidance, and duplicate-tool
handling.

To make this convenient for non-SDK users, the next product step should be a small extension upgrade:

1. Add evidence config to `.pi/drive9.json`, or derive a safe evidence root from the Drive9 workspace plus Pi session id.
2. Register `result_read` and `result_search` from the package extension, not only from the low-level integration preset.
3. Compose the evidence `afterToolCall` fallback into the Pi extension path.
4. Add `/drive9 verify evidence` that writes an oversized synthetic result, confirms the model-visible reference is small, and confirms bounded search/read works.
5. Publish a tiny demo repo/template with `.pi/settings.json` + `.pi/drive9.json` and no secrets, so a teammate can clone, set `DRIVE9_SERVER` / `DRIVE9_API_KEY`, run `pi --approve`, and see the behavior.

Public wording should distinguish:

- "Install the Pi package to use Drive9 as the agent workspace filesystem."
- "Use the Agent SDK preset, or the upcoming extension evidence mode, to keep large tool results as Drive9 references."
