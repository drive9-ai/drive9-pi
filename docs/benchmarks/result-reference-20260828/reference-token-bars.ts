import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";
import {
  createAfterToolCallFallback,
  createResultReadTool,
  createResultSearchTool,
} from "../../../src/pi-adapters.js";
import { PersistentToolResultStore } from "../../../src/tool-result-store.js";
import {
  ResultStoreError,
  type ResultStoreBackend,
  type ResultStoreObject,
  type ToolResultIdentity,
} from "../../../src/tool-result-types.js";

// Reproduce with:
//   npm install --prefix /tmp/drive9-pi-tokenizer gpt-tokenizer@4.0.0
//   NODE_PATH=/tmp/drive9-pi-tokenizer/node_modules npx tsx docs/benchmarks/result-reference-20260828/reference-token-bars.ts
const require = createRequire(import.meta.url);
const { encode } = require("gpt-tokenizer/model/gpt-4o") as { encode: (value: string) => number[] };

type Marker = {
  name: string;
  query: string;
  text: string;
  line: number;
};

type ToolOutput = {
  toolCallId: string;
  toolName: string;
  text: string;
  markers: Marker[];
};

type Scenario = {
  id: string;
  label: string;
  task: string;
  outputs: ToolOutput[];
  requiredMarkerNames: string[];
};

type ScenarioResult = {
  id: string;
  label: string;
  task: string;
  toolOutputCount: number;
  rawBytes: number;
  inlineTokens: number;
  referenceTokens: number;
  searchTokens: number;
  readTokens: number;
  referencePlusRetrievalTokens: number;
  referenceTaskTotalTokens: number;
  peakInlineTokens: number;
  peakReferenceTokens: number;
  peakReferencePlusRetrievalTokens: number;
  retrievalCalls: number;
  tokenReductionPercent: number;
};

class MemoryBackend implements ResultStoreBackend {
  readonly objects = new Map<string, ResultStoreObject>();
  private revision = 0;

  async create(path: string, data: Uint8Array): Promise<{ revision: number }> {
    if (this.objects.has(path)) throw new ResultStoreError("conflict", "exists");
    const revision = ++this.revision;
    this.objects.set(path, { data: Uint8Array.from(data), revision });
    return { revision };
  }

  async read(path: string): Promise<ResultStoreObject> {
    const object = this.objects.get(path);
    if (object === undefined) throw new ResultStoreError("not_found", "missing");
    return { data: Uint8Array.from(object.data), revision: object.revision };
  }

  async replace(path: string, data: Uint8Array, expectedRevision: number): Promise<{ revision: number }> {
    const object = this.objects.get(path);
    if (object === undefined) throw new ResultStoreError("not_found", "missing");
    if (object.revision !== expectedRevision) throw new ResultStoreError("conflict", "revision mismatch");
    const revision = ++this.revision;
    this.objects.set(path, { data: Uint8Array.from(data), revision });
    return { revision };
  }
}

function identity(sessionId: string, runId: string, toolCallId: string, attempt = 0): ToolResultIdentity {
  return { sessionId, runId, toolCallId, attempt };
}

function toolContext(text: string, toolCallId: string, toolName: string): AfterToolCallContext {
  return {
    assistantMessage: {} as AfterToolCallContext["assistantMessage"],
    toolCall: { type: "toolCall", id: toolCallId, name: toolName, arguments: {} },
    args: {},
    result: { content: [{ type: "text", text }], details: { raw: true } },
    isError: false,
    context: { systemPrompt: "", messages: [] },
  };
}

function textFrom(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function tokens(value: string): number {
  return encode(value).length;
}

function escapeCSV(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function makeLines(
  lineCount: number,
  filler: (line: number) => string,
  markerSpecs: Array<Omit<Marker, "line"> & { at: number }>,
): { text: string; markers: Marker[] } {
  const markers = markerSpecs.map((marker) => ({ ...marker, line: Math.max(0, Math.min(lineCount - 1, marker.at)) }));
  const byLine = new Map(markers.map((marker) => [marker.line, marker]));
  const lines: string[] = [];
  for (let line = 0; line < lineCount; line += 1) {
    const marker = byLine.get(line);
    const prefix = filler(line);
    lines.push(marker === undefined ? prefix : `${prefix} ${marker.text}`);
  }
  return { text: `${lines.join("\n")}\n`, markers };
}

function goTestScenario(): Scenario {
  const { text, markers } = makeLines(
    12_000,
    (line) =>
      [
        `go-test line=${line.toString().padStart(5, "0")}`,
        "pkg=./...",
        "event=stdout",
        "case=TestWorkspaceMutation",
        "noise=cache logs setup teardown parallel output",
      ].join(" "),
    [
      {
        name: "root-cause",
        query: "ROOT_CAUSE",
        text: "ROOT_CAUSE first failing test=TestLayerCommitPreservesExternalWrite error=expected 409 conflict got 200",
        at: 8_900,
      },
      {
        name: "failing-package",
        query: "FAIL_PACKAGE",
        text: "FAIL_PACKAGE pkg=github.com/drive9/fs/pkg/server duration=41.8s",
        at: 10_750,
      },
    ],
  );
  return {
    id: "go-test-log",
    label: "go test log",
    task: "Find the first root cause and failing package from a large test log whose useful lines are outside preview.",
    outputs: [{ toolCallId: "go-test-1", toolName: "bash", text, markers }],
    requiredMarkerNames: ["root-cause", "failing-package"],
  };
}

function tscScenario(): Scenario {
  const { text, markers } = makeLines(
    8_000,
    (line) =>
      [
        `tsc line=${line.toString().padStart(5, "0")}`,
        "project=drive9-pi",
        "phase=incremental-check",
        "noise=resolved module symbol diagnostics skipped declaration emit",
      ].join(" "),
    [
      {
        name: "ts-file",
        query: "TS_ROOT_ERROR",
        text: "TS_ROOT_ERROR file=src/pi-adapters.ts:247:19 code=TS2345 reason=ToolResultIdentity missing sessionId",
        at: 6_120,
      },
      {
        name: "ts-related",
        query: "TS_RELATED",
        text: "TS_RELATED file=src/tool-result-types.ts:31:3 symbol=ToolResultIdentity.sessionId",
        at: 7_640,
      },
    ],
  );
  return {
    id: "tsc-log",
    label: "tsc build log",
    task: "Locate the real TypeScript file and related symbol after thousands of noisy compiler lines.",
    outputs: [{ toolCallId: "tsc-1", toolName: "bash", text, markers }],
    requiredMarkerNames: ["ts-file", "ts-related"],
  };
}

function rgScenario(): Scenario {
  const { text, markers } = makeLines(
    16_000,
    (line) =>
      [
        `repo/path/file_${line.toString().padStart(5, "0")}.ts:${line}:`,
        "match=ResultStore",
        "context=ordinary search hit around adapters stores tests docs generated fixtures",
      ].join(" "),
    [
      {
        name: "tail-match",
        query: "TAIL_FACT",
        text: "TAIL_FACT file=src/pi-integration.ts line=231 fact=afterToolCall fallback is composed after Drive9 tools are registered",
        at: 15_720,
      },
    ],
  );
  return {
    id: "repo-rg",
    label: "repo-wide rg",
    task: "Answer a fact that appears near the tail of a repo-wide search result.",
    outputs: [{ toolCallId: "rg-1", toolName: "bash", text, markers }],
    requiredMarkerNames: ["tail-match"],
  };
}

function multiRoundScenario(): Scenario {
  const outputs: ToolOutput[] = [];
  for (let round = 1; round <= 5; round += 1) {
    const { text, markers } = makeLines(
      5_000,
      (line) =>
        [
          `round=${round}`,
          `line=${line.toString().padStart(5, "0")}`,
          "tool=diagnostic",
          "noise=large multi-step agent trace with repeated build test grep and deploy checks",
        ].join(" "),
      [
        {
          name: `round-${round}-fact`,
          query: `ROUND_${round}_FACT`,
          text: `ROUND_${round}_FACT value=drive9-evidence-${round}-marker location=preview-outside`,
          at: 4_620,
        },
      ],
    );
    outputs.push({ toolCallId: `multi-${round}`, toolName: "bash", text, markers });
  }
  return {
    id: "five-round",
    label: "5-round task",
    task: "After five large tool outputs, answer using facts from rounds 1, 3, and 5.",
    outputs,
    requiredMarkerNames: ["round-1-fact", "round-3-fact", "round-5-fact"],
  };
}

async function evaluateScenario(scenario: Scenario): Promise<ScenarioResult> {
  const sessionId = `token-${scenario.id}`;
  const backend = new MemoryBackend();
  const store = new PersistentToolResultStore({ backend });
  const fallback = createAfterToolCallFallback({
    store,
    thresholdBytes: 4 * 1024,
    previewBytes: 2 * 1024,
    allocateIdentity: ({ toolCallId }) => identity(sessionId, "run-1", toolCallId),
  });
  const readTool = createResultReadTool({ store, currentSessionId: () => sessionId });
  const searchTool = createResultSearchTool({ store, currentSessionId: () => sessionId });

  let rawBytes = 0;
  let inlineTokens = 0;
  let referenceTokens = 0;
  let peakInlineTokens = 0;
  const resultsByMarker = new Map<string, { resultId: string; marker: Marker }>();

  for (const output of scenario.outputs) {
    rawBytes += bytes(output.text);
    const rawTokens = tokens(output.text);
    inlineTokens += rawTokens;
    peakInlineTokens += rawTokens;

    const compact = await fallback(toolContext(output.text, output.toolCallId, output.toolName));
    assert.notEqual(compact, undefined);
    if (compact === undefined) throw new Error(`${scenario.id} did not compact ${output.toolCallId}`);

    const compactText = textFrom(compact);
    const compactTokens = tokens(compactText);
    referenceTokens += compactTokens;

    const details = compact.details as { resultId: string };
    for (const marker of output.markers) {
      assert.equal(compactText.includes(marker.text), false, `${scenario.id}:${marker.name} leaked into preview`);
      resultsByMarker.set(marker.name, { resultId: details.resultId, marker });
    }
  }

  let searchTokens = 0;
  let readTokens = 0;
  for (const markerName of scenario.requiredMarkerNames) {
    const item = resultsByMarker.get(markerName);
    if (item === undefined) throw new Error(`${scenario.id} missing marker ${markerName}`);
    const search = await searchTool.execute(`${scenario.id}-${markerName}-search`, {
      resultId: item.resultId,
      query: item.marker.query,
      contextBytes: 360,
      maxMatches: 1,
    });
    const searchText = textFrom(search);
    assert.match(searchText, new RegExp(item.marker.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    searchTokens += tokens(searchText);

    const read = await readTool.execute(`${scenario.id}-${markerName}-read`, {
      resultId: item.resultId,
      startLine: Math.max(0, item.marker.line - 2),
      maxLines: 5,
      maxBytes: 4096,
    });
    const readText = textFrom(read);
    assert.equal(readText.includes(item.marker.text), true);
    readTokens += tokens(readText);
  }

  const referencePlusRetrievalTokens = referenceTokens + searchTokens + readTokens;
  return {
    id: scenario.id,
    label: scenario.label,
    task: scenario.task,
    toolOutputCount: scenario.outputs.length,
    rawBytes,
    inlineTokens,
    referenceTokens,
    searchTokens,
    readTokens,
    referencePlusRetrievalTokens,
    referenceTaskTotalTokens: referenceTokens + referencePlusRetrievalTokens,
    peakInlineTokens,
    peakReferenceTokens: referenceTokens,
    peakReferencePlusRetrievalTokens: referencePlusRetrievalTokens,
    retrievalCalls: scenario.requiredMarkerNames.length * 2,
    tokenReductionPercent: Number(((1 - referencePlusRetrievalTokens / inlineTokens) * 100).toFixed(2)),
  };
}

function yFor(value: number, maxValue: number, top: number, bottom: number): number {
  const safe = Math.max(1, value);
  const max = Math.max(10, maxValue);
  const minLog = 2;
  const maxLog = Math.ceil(Math.log10(max));
  const ratio = (Math.log10(safe) - minLog) / (maxLog - minLog);
  return bottom - Math.max(0, Math.min(1, ratio)) * (bottom - top);
}

function fmt(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(value);
}

function svgBarChart(
  title: string,
  subtitle: string,
  rows: ScenarioResult[],
  fields: Array<{ key: keyof ScenarioResult; label: string; color: string }>,
): string {
  const width = 2400;
  const height = 1350;
  const left = 170;
  const right = 90;
  const top = 185;
  const bottom = 900;
  const maxValue = Math.max(...rows.flatMap((row) => fields.map((field) => Number(row[field.key]))));
  const groupWidth = (width - left - right) / rows.length;
  const barWidth = 92;
  const chartHeight = bottom - top;
  const ticks = [100, 1_000, 10_000, 100_000, 1_000_000];

  const grid = ticks
    .filter((tick) => tick <= maxValue * 1.05)
    .map((tick) => {
      const y = yFor(tick, maxValue, top, bottom);
      return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" stroke="#d9dee8" stroke-width="2"/><text x="${left - 22}" y="${y + 9}" text-anchor="end" font-size="30" fill="#5b6472">${fmt(tick)}</text>`;
    })
    .join("\n");

  const bars = rows
    .map((row, rowIndex) => {
      const groupX = left + rowIndex * groupWidth;
      const center = groupX + groupWidth / 2;
      const totalBarWidth = fields.length * barWidth + (fields.length - 1) * 20;
      const startX = center - totalBarWidth / 2;
      const rects = fields
        .map((field, fieldIndex) => {
          const value = Number(row[field.key]);
          const x = startX + fieldIndex * (barWidth + 20);
          const y = yFor(value, maxValue, top, bottom);
          const barHeight = bottom - y;
          return [
            `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${field.color}" rx="10"/>`,
            `<text x="${x + barWidth / 2}" y="${Math.max(top + 32, y - 18)}" text-anchor="middle" font-size="30" font-weight="700" fill="#1f2937">${fmt(value)}</text>`,
          ].join("\n");
        })
        .join("\n");
      return [
        rects,
        `<text x="${center}" y="${bottom + 58}" text-anchor="middle" font-size="35" font-weight="700" fill="#172033">${row.label}</text>`,
        `<text x="${center}" y="${bottom + 103}" text-anchor="middle" font-size="27" fill="#687386">${row.toolOutputCount} output${row.toolOutputCount === 1 ? "" : "s"}, ${row.retrievalCalls} retrieval calls</text>`,
        `<text x="${center}" y="${bottom + 143}" text-anchor="middle" font-size="27" fill="#687386">${row.tokenReductionPercent}% less than inline</text>`,
      ].join("\n");
    })
    .join("\n");

  const legendY = 1115;
  const legend = fields
    .map((field, index) => {
      const x = left + index * 440;
      return `<rect x="${x}" y="${legendY}" width="32" height="32" fill="${field.color}" rx="7"/><text x="${x + 48}" y="${legendY + 27}" font-size="31" fill="#2d3748">${field.label}</text>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <text x="${left}" y="82" font-size="58" font-weight="800" fill="#111827">${title}</text>
  <text x="${left}" y="132" font-size="34" fill="#526174">${subtitle}</text>
  <rect x="${left}" y="${top}" width="${width - left - right}" height="${chartHeight}" fill="#ffffff" stroke="#d8dee9" stroke-width="2" rx="18"/>
  ${grid}
  <line x1="${left}" y1="${bottom}" x2="${width - right}" y2="${bottom}" stroke="#9aa4b2" stroke-width="3"/>
  <text x="65" y="${top + chartHeight / 2}" transform="rotate(-90 65 ${top + chartHeight / 2})" text-anchor="middle" font-size="32" font-weight="700" fill="#334155">estimated input tokens (log scale)</text>
  ${bars}
  ${legend}
  <text x="${left}" y="1240" font-size="28" fill="#526174">Tokenizer: gpt-tokenizer@4.0.0, gpt-4o vocabulary. Shared system/user prompt overhead excluded. These are benchmark estimates, not provider-billed usage.</text>
  <text x="${left}" y="1286" font-size="28" fill="#526174">Source: drive9-pi 988b80f, 2026-08-28. Fetched snippets are only the bounded slices returned by result_search/result_read.</text>
</svg>
`;
}

async function main(): Promise<void> {
  const outDir = dirname(fileURLToPath(import.meta.url));
  const scenarios = [goTestScenario(), tscScenario(), rgScenario(), multiRoundScenario()];
  const results = await Promise.all(scenarios.map((scenario) => evaluateScenario(scenario)));

  const dataHeader = [
    "scenario",
    "task",
    "tool_output_count",
    "raw_bytes",
    "inline_tokens",
    "reference_tokens",
    "search_tokens",
    "read_tokens",
    "reference_plus_retrieval_tokens",
    "reference_task_total_tokens",
    "peak_inline_tokens",
    "peak_reference_tokens",
    "peak_reference_plus_retrieval_tokens",
    "retrieval_calls",
    "token_reduction_percent",
  ];
  const dataRows = results.map((result) =>
    [
      result.label,
      result.task,
      result.toolOutputCount,
      result.rawBytes,
      result.inlineTokens,
      result.referenceTokens,
      result.searchTokens,
      result.readTokens,
      result.referencePlusRetrievalTokens,
      result.referenceTaskTotalTokens,
      result.peakInlineTokens,
      result.peakReferenceTokens,
      result.peakReferencePlusRetrievalTokens,
      result.retrievalCalls,
      result.tokenReductionPercent,
    ]
      .map(escapeCSV)
      .join(","),
  );

  await writeFile(resolve(outDir, "result-reference-token-bars.csv"), `${dataHeader.join(",")}\n${dataRows.join("\n")}\n`);
  await writeFile(
    resolve(outDir, "result-reference-token-scenarios.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceSHA: "988b80f",
        tokenizer: "gpt-tokenizer@4.0.0 model/gpt-4o",
        note: "Shared prompt overhead is excluded. Token counts are tokenizer estimates, not provider-billed usage.",
        scenarios: results,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    resolve(outDir, "result-reference-token-peak-bars.svg"),
    svgBarChart("Drive9 Result References: Peak Context Tokens", "Concrete tool-result tasks, fixed tokenizer estimate", results, [
      { key: "peakInlineTokens", label: "Full inline result", color: "#dc6b4a" },
      { key: "peakReferenceTokens", label: "Drive9 reference", color: "#2563eb" },
      { key: "peakReferencePlusRetrievalTokens", label: "Reference + fetched snippets", color: "#15936b" },
    ]),
  );
  await writeFile(
    resolve(outDir, "result-reference-token-cumulative-bars.svg"),
    svgBarChart("Drive9 Result References: Task Evidence Tokens", "Reference mode counts the handle plus only the fetched snippets", results, [
      { key: "inlineTokens", label: "Full inline result", color: "#dc6b4a" },
      { key: "referenceTokens", label: "Drive9 reference", color: "#2563eb" },
      { key: "referenceTaskTotalTokens", label: "Ref + snippets total", color: "#15936b" },
    ]),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
