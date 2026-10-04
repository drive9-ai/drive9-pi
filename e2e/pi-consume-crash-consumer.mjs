import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lookup as systemLookup } from "node:dns";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createDrive9ConversationCreated,
  createDrive9DurableExtension,
  createDrive9WorkspaceCoordinator,
  Drive9LayerWorkspaceBackend,
  Drive9ProtocolError,
  openDrive9SingleCoordinatorStorage,
  verifyRuntimeIsolation,
} from "@drive9/drive9-pi";
import {
  createRegistry,
  Harness,
} from "@earendil-works/pi-durable";
import {
  err,
  ExecutionError,
  FileError,
  ok,
} from "@earendil-works/pi-durable/env";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Client } from "drive9";
import { Agent, setGlobalDispatcher } from "undici";

const apiAddress = process.env.DRIVE9_PI_E2E_API_ADDRESS;
const dispatcherOptions = { pipelining: 0 };
if (apiAddress !== undefined) {
  const family = isIP(apiAddress);
  assert.notEqual(family, 0, "DRIVE9_PI_E2E_API_ADDRESS must be an IP address");
  dispatcherOptions.connect = {
    lookup(hostname, options, callback) {
      if (hostname !== "api.drive9.ai") {
        systemLookup(hostname, options, callback);
        return;
      }
      if (options?.all === true) callback(null, [{ address: apiAddress, family }]);
      else callback(null, apiAddress, family);
    },
  };
}
setGlobalDispatcher(
  new Agent({
    ...dispatcherOptions,
  }),
);

const context = BACKGROUND_CONTEXT;
const required = process.env.DRIVE9_E2E_REQUIRED === "1";
const workerPhaseTimeoutMs = Number(process.env.DRIVE9_PI_WORKER_TIMEOUT_MS ?? 360_000);
const workerTotalTimeoutMs = Number(process.env.DRIVE9_PI_WORKER_TOTAL_TIMEOUT_MS ?? 1_800_000);
const SCOPED_TOKEN_TTL_SECONDS = 7_200;
const role = process.env.DRIVE9_PI_CONSUMER_ROLE ?? "controller";
const self = fileURLToPath(import.meta.url);
const packageUrl = import.meta.resolve("@drive9/drive9-pi");
const packagePath = realpathSync(fileURLToPath(packageUrl));
const PUBLISHED_A = "published A\n";
const FINAL_C = "published C\n";
const FILE_NAME = "state.txt";
const MAX_LAYER_DEPTH = 16;
const SCRIPTED_PROVIDER = "drive9-pi-scripted";
const SCRIPTED_MODEL = "drive9-pi-scripted-1";
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

assert.match(
  packagePath,
  /node_modules\/@drive9\/drive9-pi\/dist\/index\.js$/,
  "consumer must load the realpath of @drive9/drive9-pi from the clean install",
);
assert.ok(
  Number.isSafeInteger(workerPhaseTimeoutMs) && workerPhaseTimeoutMs > 0,
  "worker phase timeout must be positive",
);
assert.ok(
  Number.isSafeInteger(workerTotalTimeoutMs) && workerTotalTimeoutMs > 0,
  "worker total timeout must be positive",
);
assert.ok(
  SCOPED_TOKEN_TTL_SECONDS * 1_000 > workerTotalTimeoutMs,
  "scoped token lifetime must exceed the bounded worker run",
);

function statusCode(error) {
  if (typeof error !== "object" || error === null) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function isMissing(error) {
  return statusCode(error) === 404 || String(error).toLowerCase().includes("not found");
}

function isConflict(error) {
  return statusCode(error) === 409 || String(error).toLowerCase().includes("already exists");
}

async function requireDenied(label, operation) {
  try {
    await operation();
  } catch (error) {
    if (statusCode(error) === 401 || statusCode(error) === 403) return;
    throw new Error(`${label} did not return an explicit authorization denial`, { cause: error });
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

function compactId(prefix) {
  return `${prefix}${randomUUID().replaceAll("-", "")}`.slice(0, 50);
}

function checkpointId(prefix) {
  return `${prefix}${randomUUID().replaceAll("-", "")}`.slice(0, 64);
}

function absoluteWorkspacePath(root) {
  return posix.join(root, FILE_NAME);
}

function assertWithin(root, path) {
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new FileError("permission_denied", "path escapes the Drive9 workspace", path);
  }
}

async function message(value) {
  if (typeof process.send !== "function") throw new Error("worker has no IPC channel");
  await new Promise((resolve, reject) => {
    process.send(value, (error) => {
      if (error !== null && error !== undefined) reject(error);
      else resolve();
    });
  });
}

function never() {
  return new Promise(() => {
    setInterval(() => {}, 60_000);
  });
}

async function ensureDirectory(client, path) {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    try {
      await client.mkdir(current, 0o700);
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
}

async function ensureExactDirectory(client, path) {
  try {
    await client.mkdir(path, 0o700);
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
}

function toolCall(name, args, id) {
  return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

function finalAnswer(text) {
  return fauxAssistantMessage([fauxText(text)]);
}

function scriptedProvider(responses, progress) {
  const pending = [...responses];
  const model = {
    id: SCRIPTED_MODEL,
    name: "Drive9 Pi deterministic release-gate model",
    api: SCRIPTED_PROVIDER,
    provider: SCRIPTED_PROVIDER,
    baseUrl: "http://localhost:0",
    reasoning: false,
    input: ["text"],
    cost: ZERO_USAGE.cost,
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  const stream = (requestModel, _modelContext, options) => {
    const events = createAssistantMessageEventStream();
    const response = pending.shift();
    queueMicrotask(async () => {
      try {
        await progress("model:response-started");
        await options?.onResponse?.({ status: 200, headers: {} }, requestModel);
        if (response === undefined) throw new Error("no scripted model response remains");
        const message = {
          ...structuredClone(response),
          api: SCRIPTED_PROVIDER,
          provider: SCRIPTED_PROVIDER,
          model: requestModel.id,
          usage: ZERO_USAGE,
          timestamp: Date.now(),
        };
        events.push({ type: "done", reason: message.stopReason, message });
        events.end(message);
        await progress("model:response-completed");
      } catch (error) {
        const message = {
          role: "assistant",
          content: [],
          api: SCRIPTED_PROVIDER,
          provider: SCRIPTED_PROVIDER,
          model: requestModel.id,
          usage: ZERO_USAGE,
          stopReason: "error",
          errorMessage: serializeError(error),
          timestamp: Date.now(),
        };
        events.push({ type: "error", reason: "error", error: message });
        events.end(message);
      }
    });
    return events;
  };
  return createProvider({
    id: SCRIPTED_PROVIDER,
    auth: { apiKey: { name: "Scripted", resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: { stream, streamSimple: stream },
  });
}

function serializeError(error) {
  const messages = [];
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (!(current instanceof Error)) {
      messages.push(String(current));
      break;
    }
    messages.push(`${current.name}: ${current.message}`);
    current = current.cause;
    if (current === undefined) break;
  }
  return messages.join(" <- ");
}

function diagnosticError(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    const code = typeof current.code === "string" ? `:${current.code}` : "";
    const status = typeof current.statusCode === "number" ? `:${current.statusCode}` : "";
    parts.push(`${current.name}${code}${status}`);
    current = current.cause;
  }
  return parts.length === 0 ? "UnknownError" : parts.join(" <- ");
}

class Drive9BindingStore {
  constructor(client, path) {
    this.client = client;
    this.path = path;
    this.cached = undefined;
    this.revision = 0;
  }

  async readBinding(conversationId) {
    try {
      const stat = await this.client.stat(this.path);
      const parsed = JSON.parse(Buffer.from(await this.client.read(this.path)).toString("utf8"));
      if (Number(parsed.conversationId) !== Number(conversationId)) {
        throw new Error("binding belongs to another conversation");
      }
      this.cached = parsed;
      this.revision = stat.revision;
      return parsed;
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.cached = undefined;
      this.revision = 0;
      return undefined;
    }
  }

  async compareAndSetBinding(input) {
    const current = await this.readBinding(input.conversationId);
    const previousLayerId = current?.handle.layerId ?? null;
    if (previousLayerId !== input.expectedLayerId) {
      const error = new Error("binding compare-and-set expected layer mismatch");
      error.statusCode = 409;
      throw error;
    }
    const binding = {
      conversationId: Number(input.conversationId),
      writerEpoch: input.writerEpoch,
      publishedCandidateKey: input.publishedCandidateKey,
      handle: input.handle,
    };
    this.revision = await this.client.writeWithRevision(
      this.path,
      Buffer.from(`${JSON.stringify(binding)}\n`),
      { expectedRevision: this.revision },
    );
    this.cached = binding;
    return { previousLayerId, binding };
  }

  requireCached() {
    if (this.cached === undefined) throw new Error("workspace binding is not loaded");
    return this.cached;
  }
}

class LayerExecutionEnv {
  constructor(options) {
    this.client = options.client;
    this.bindings = options.bindings;
    this.workspaceRoot = options.workspaceRoot;
    this.cwd = options.cwd;
    this.crashStage = options.crashStage;
    this.crash = options.crash;
    this.expectedReads = options.expectedReads;
    this.operations = options.operations;
    this.progress = options.progress;
    this.crashSignalled = false;
  }

  get id() {
    return this.bindings.requireCached().handle.executionEnvId;
  }

  addressed(path) {
    const addressed = path.startsWith("/") ? posix.normalize(path) : posix.resolve(this.cwd, path);
    assertWithin(this.workspaceRoot, addressed);
    return addressed;
  }

  layerId() {
    return this.bindings.requireCached().handle.layerId;
  }

  async absolutePath(path, callContext) {
    try {
      callContext.abortSignal?.throwIfAborted();
      return ok(this.addressed(path));
    } catch (error) {
      return err(error instanceof FileError ? error : new FileError("invalid", serializeError(error), path));
    }
  }

  async joinPath(parts, callContext) {
    return this.absolutePath(posix.join(...parts), callContext);
  }

  async readBinaryFile(path, callContext) {
    try {
      callContext.abortSignal?.throwIfAborted();
      const addressed = this.addressed(path);
      await this.progress("tool:workspace-read-started");
      const bytes = await this.client.readFSLayerFile(this.layerId(), addressed);
      await this.progress("tool:workspace-read-completed");
      callContext.abortSignal?.throwIfAborted();
      this.operations.reads += 1;
      return ok(bytes);
    } catch (error) {
      await this.progress("tool:workspace-read-failed");
      return err(new FileError(isMissing(error) ? "not_found" : "unknown", serializeError(error), path));
    }
  }

  async readTextFile(path, callContext) {
    const result = await this.readBinaryFile(path, callContext);
    if (!result.ok) return result;
    const text = Buffer.from(result.value).toString("utf8");
    const expected = this.expectedReads.shift();
    if (expected !== undefined) {
      assert.equal(text, expected, "replayed mutation must start from the last published bytes");
    }
    return ok(text);
  }

  async writeFile(path, content, callContext) {
    try {
      callContext.abortSignal?.throwIfAborted();
      const addressed = this.addressed(path);
      const bytes = typeof content === "string" ? Buffer.from(content) : content;
      await this.progress("tool:workspace-upload-started");
      await this.client.uploadFSLayerFile(this.layerId(), addressed, bytes);
      await this.progress("tool:workspace-upload-completed");
      callContext.abortSignal?.throwIfAborted();
      this.operations.writes += 1;
      if (this.crashStage === "dirty" && !this.crashSignalled) {
        this.crashSignalled = true;
        await this.progress("tool:dirty-crash-point");
        await this.crash({ stage: "dirty", layerId: this.layerId() });
        await never();
      }
      return ok(undefined);
    } catch (error) {
      if (error instanceof FileError) return err(error);
      return err(new FileError("unknown", serializeError(error), path));
    }
  }

  async fileInfo(path, callContext) {
    const result = await this.readBinaryFile(path, callContext);
    if (!result.ok) return result;
    const addressed = this.addressed(path);
    return ok({
      name: posix.basename(addressed),
      path: addressed,
      kind: "file",
      size: result.value.byteLength,
      mtimeMs: 0,
    });
  }

  async exists(path, callContext) {
    const result = await this.readBinaryFile(path, callContext);
    if (result.ok) return ok(true);
    if (result.error.code === "not_found") return ok(false);
    return result;
  }

  async canonicalPath(path, callContext) {
    return this.absolutePath(path, callContext);
  }

  async unsupported(path, name) {
    return err(new FileError("not_supported", `${name} is not needed by this release gate`, path));
  }

  async openTextLineReader(path) { return this.unsupported(path, "openTextLineReader"); }
  async readTextLines(path) { return this.unsupported(path, "readTextLines"); }
  async appendFile(path) { return this.unsupported(path, "appendFile"); }
  async truncateFile(path) { return this.unsupported(path, "truncateFile"); }
  async flushFile() { return ok(undefined); }
  async renameFile(path) { return this.unsupported(path, "renameFile"); }
  async listDir(path) { return this.unsupported(path, "listDir"); }
  async createDir(path) { return this.unsupported(path, "createDir"); }
  async remove(path) { return this.unsupported(path, "remove"); }
  async createTempDir(path) { return this.unsupported(path ?? this.workspaceRoot, "createTempDir"); }
  async createTempFile() { return this.unsupported(this.workspaceRoot, "createTempFile"); }
  async cleanup() {}

  async exec(_command, _options, callContext) {
    if (callContext.abortSignal?.aborted) {
      return err(new ExecutionError("aborted", "execution was aborted"));
    }
    return err(new ExecutionError("shell_unavailable", "this release gate is file-only"));
  }
}

function instrumentLayerClient(client, options) {
  const count = options.mutationCounts;
  return {
    getFSLayer: (layerId) => client.getFSLayer(layerId),
    listFSLayers: () => client.listFSLayers(),
    forkFSLayer: async (parentRef, request) => {
      count.forks += 1;
      return await client.forkFSLayer(parentRef, request);
    },
    deleteFSLayer: async (layerId, deleteOptions) => {
      count.deletes += 1;
      return await client.deleteFSLayer(layerId, deleteOptions);
    },
    checkpointFSLayer: async (layerId, request) => {
      count.checkpoints += 1;
      await options.progress("coordinator:checkpoint-requested");
      const created = await client.checkpointFSLayer(layerId, request);
      await options.progress("coordinator:checkpoint-created");
      if (options.crashStage === "checkpoint" && !options.state.checkpointSignalled) {
        options.state.checkpointSignalled = true;
        await options.crash({
          stage: "checkpoint",
          layerId,
          checkpointId: created.checkpoint_id,
        });
        await never();
      }
      return created;
    },
    getFSLayerCheckpoint: (id) => client.getFSLayerCheckpoint(id),
    listFSLayerEvents: (layerId, since) => client.listFSLayerEvents(layerId, since),
  };
}

function instrumentStateClient(client, progress) {
  const call = async (name, operation) => {
    await progress(`state:${name}-started`);
    const result = await operation();
    await progress(`state:${name}-completed`);
    return result;
  };
  return {
    read: (path) => call("read", async () => await client.read(path)),
    write: (path, data) => call("write", async () => await client.write(path, data)),
    append: (path, data) => call("append", async () => await client.append(path, data)),
    list: (path) => call("list", async () => await client.list(path)),
    stat: (path) => call("stat", async () => await client.stat(path)),
    rename: (source, destination) => call("rename", async () => await client.rename(source, destination)),
    mkdir: (path, mode) => call("mkdir", async () => await client.mkdir(path, mode)),
    deleteFile: (path) => call("delete-file", async () => await client.deleteFile(path)),
    deleteDir: (path) => call("delete-dir", async () => await client.deleteDir(path)),
    removeAll: (path) => call("remove-all", async () => await client.removeAll(path)),
    ...(client.readStream === undefined
      ? {}
      : { readStream: (path) => call("read-stream", async () => await client.readStream(path)) }),
    ...(client.writeWithRevision === undefined
      ? {}
      : {
          writeWithRevision: (path, data, options) =>
            call("write-with-revision", async () => await client.writeWithRevision(path, data, options)),
        }),
    ...(client.createFile === undefined
      ? {}
      : { createFile: (path) => call("create-file", async () => await client.createFile(path)) }),
  };
}

function wrapStorage(inner, options) {
  return new Proxy(inner, {
    get(target, property) {
      if (property === "commit") {
        return async (writes, callContext) => {
          await options.progress("storage:commit-started");
          const candidateWrites = writes.filter(
            (write) => write.type === "entry" && write.value?.kind === "drive9.workspace-candidate",
          );
          if (candidateWrites.length === 0) {
            const seq = await target.commit(writes, callContext);
            await options.progress("storage:commit-completed");
            return seq;
          }
          assert.equal(candidateWrites.length, 1, "candidate commit must contain one candidate");
          assert.equal(writes.length, 1, "candidate commit must not carry unrelated writes");
          const candidate = candidateWrites[0].value.data;
          if (options.mode === "candidate") {
            await options.progress("storage:candidate-commit-started");
            const seq = await target.commit(writes, callContext);
            await options.progress("storage:candidate-commit-completed");
            await options.crash({
              stage: "candidate",
              layerId: candidate.checkpoint.layerId,
              checkpointId: candidate.checkpoint.checkpointId,
              candidateKey: candidate.candidateKey,
            });
            await never();
            return seq;
          }
          if (options.mode === "drop-candidate") {
            await options.progress("storage:dropped-candidate-commit-started");
            const seq = await target.commit([], callContext);
            await options.progress("storage:dropped-candidate-commit-completed");
            options.dropped.push(candidate);
            return seq;
          }
          const seq = await target.commit(writes, callContext);
          await options.progress("storage:commit-completed");
          return seq;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function scanEntries(storage, conversationId) {
  const entries = [];
  let cursor;
  do {
    const page = await storage.scanEntries({ conversationId }, 256, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
}

function entryModelShapes(entries) {
  return entries.map((entry) => ({
    kind: entry.kind,
    model: Array.isArray(entry.model)
      ? entry.model.map((item) => ({
          role: item?.role,
          content: Array.isArray(item?.content) ? "array" : typeof item?.content,
        }))
      : typeof entry.model,
  }));
}

async function openRuntime(config, options) {
  const progress = async (step) => await message({ type: "progress", step });
  const stateClient = new Client(config.baseUrl, config.stateToken);
  const workspaceClient = new Client(config.baseUrl, config.workspaceToken);
  await ensureExactDirectory(stateClient, config.piStateRoot);
  await ensureExactDirectory(stateClient, posix.dirname(config.bindingPath));

  const innerStorage = await openDrive9SingleCoordinatorStorage(
    {
      client: instrumentStateClient(stateClient, progress),
      stateRoot: config.piStateRoot,
      coordination: "externally-exclusive",
      id: `drive9-state:${config.stateRoot}`,
    },
    context,
  );
  const dropped = [];
  const storage = wrapStorage(innerStorage, {
    mode: options.storageMode,
    dropped,
    crash: options.crash,
    progress,
  });
  const bindings = new Drive9BindingStore(stateClient, config.bindingPath);
  const mutationCounts = { forks: 0, checkpoints: 0, deletes: 0 };
  const backend = new Drive9LayerWorkspaceBackend({
    client: instrumentLayerClient(workspaceClient, {
      crashStage: options.crashStage,
      crash: options.crash,
      mutationCounts,
      state: { checkpointSignalled: false },
      progress,
    }),
    bindings,
  });
  const baseCoordinator = createDrive9WorkspaceCoordinator({
    sessionId: config.sessionId,
    storage,
    backend,
    initialCheckpoint: async () => config.initialCheckpoint,
    maxLayerDepth: MAX_LAYER_DEPTH,
    mode: { kind: "single-coordinator-preview", writerEpoch: config.writerEpoch },
  });
  const caughtCodes = [];
  const coordinator = {
    prepare: async (input, callContext) => {
      await progress("coordinator:prepare-started");
      try {
        const prepared = await baseCoordinator.prepare(input, callContext);
        await progress("coordinator:prepare-completed");
        return prepared;
      } catch (error) {
        if (options.captureProtocolErrors && error instanceof Drive9ProtocolError) {
          caughtCodes.push(error.code);
        }
        throw error;
      }
    },
    checkpointAndVerify: async (request, callContext) => {
      await progress("coordinator:checkpoint-verify-started");
      const checkpoint = await baseCoordinator.checkpointAndVerify(request, callContext);
      await progress("coordinator:checkpoint-verify-completed");
      return checkpoint;
    },
    invalidate: (plan) => baseCoordinator.invalidate(plan),
    poison: (error, callContext) => baseCoordinator.poison(error, callContext),
  };

  const models = createModels();
  models.setProvider(scriptedProvider(options.responses, progress));
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(createDrive9DurableExtension({ coordinator, prompt: false }));
  const expectedReads = [...options.expectedReads];
  const operations = { reads: 0, writes: 0 };
  const env = async (target) => {
    await bindings.readBinding(target.conversationId, context);
    return new LayerExecutionEnv({
      client: workspaceClient,
      bindings,
      workspaceRoot: config.workspaceRoot,
      cwd: target.cwd ?? config.workspaceRoot,
      crashStage: options.crashStage,
      crash: options.crash,
      expectedReads,
      operations,
      progress,
    });
  };
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env,
      conversationCreated: createDrive9ConversationCreated({ sessionId: config.sessionId }),
      onReport: (error) => {
        void message({ type: "report", error: diagnosticError(error) });
      },
    },
    context,
  );
  return {
    harness,
    storage,
    backend,
    bindings,
    workspaceClient,
    dropped,
    expectedReads,
    operations,
    mutationCounts,
    caughtCodes,
  };
}

async function seedBinding(runtime, config, conversationId) {
  const forked = await runtime.backend.forkFromCheckpoint(
    {
      source: config.initialCheckpoint,
      childIdentity: compactId("pi0_"),
      writerEpoch: config.writerEpoch,
    },
    context,
  );
  assert.equal(forked.hasUnpublishedWrites, false);
  await runtime.backend.switchBinding(
    {
      conversationId,
      writerEpoch: config.writerEpoch,
      expectedLayerId: null,
      publishedCandidateKey: null,
      handle: forked.handle,
    },
    context,
  );
}

async function runSetup(config) {
  await message({ type: "progress", step: "setup:opening-runtime" });
  const runtime = await openRuntime(config, {
    responses: [
      toolCall("write", { path: FILE_NAME, content: PUBLISHED_A }, "setup-write"),
      finalAnswer("setup complete"),
    ],
    expectedReads: [],
    crashStage: undefined,
    storageMode: undefined,
    crash: async () => { throw new Error("unexpected setup crash point"); },
    captureProtocolErrors: false,
  });
  try {
    await message({ type: "progress", step: "setup:opening-root" });
    const root = await runtime.harness.root(context, {
      agent: {
        model: { provider: SCRIPTED_PROVIDER, modelId: SCRIPTED_MODEL },
        cwd: config.workspaceRoot,
      },
    });
    await message({ type: "progress", step: "setup:seeding-binding" });
    await seedBinding(runtime, config, root.id);
    await message({ type: "progress", step: "setup:submitting-native-write" });
    const submission = await root.submit(
      { type: "input", content: "Write the initial published state." },
      context,
    );
    await message({ type: "progress", step: "setup:waiting-native-write" });
    const settled = await submission.wait(context);
    await message({ type: "progress", step: "setup:native-write-settled" });
    if (settled.status !== "done") {
      const entries = await scanEntries(runtime.storage, root.id);
      assert.fail(
        `setup submission did not complete: ${JSON.stringify(settled)}; entries=${JSON.stringify(entryModelShapes(entries))}`,
      );
    }
    return { conversationId: Number(root.id) };
  } finally {
    await runtime.harness.close(context);
  }
}

async function runCrash(config) {
  let submissionId;
  let resolveSubmission;
  const submissionReady = new Promise((resolve) => { resolveSubmission = resolve; });
  const crash = async (details) => {
    await submissionReady;
    await message({ type: "crash-point", submissionId, ...details });
  };
  const next = `unpublished ${config.stage}\n`;
  const runtime = await openRuntime(config, {
    responses: [
      toolCall(
        "edit",
        { path: FILE_NAME, edits: [{ oldText: "published A", newText: `unpublished ${config.stage}` }] },
        `crash-${config.stage}`,
      ),
      finalAnswer("must not be reached before crash"),
    ],
    expectedReads: [PUBLISHED_A],
    crashStage: config.stage,
    storageMode: config.stage === "candidate" ? "candidate" : undefined,
    crash,
    captureProtocolErrors: false,
  });
  const root = await runtime.harness.root(context);
  const submission = await root.submit({ type: "input", content: `Crash at ${config.stage}.` }, context);
  submissionId = Number(submission.id);
  resolveSubmission();
  await message({ type: "submission", submissionId, expectedUnpublished: next });
  await submission.wait(context);
  throw new Error(`crash stage ${config.stage} completed without SIGKILL`);
}

async function runRecovery(config) {
  const unpublished = `unpublished ${config.stage}\n`;
  const runtime = await openRuntime(config, {
    responses: [
      finalAnswer("replayed mutation complete"),
      toolCall(
        "edit",
        { path: FILE_NAME, edits: [{ oldText: `unpublished ${config.stage}`, newText: "published C" }] },
        `next-${config.stage}`,
      ),
      finalAnswer("next mutation complete"),
    ],
    expectedReads: [PUBLISHED_A, unpublished],
    crashStage: undefined,
    storageMode: undefined,
    crash: async () => { throw new Error("unexpected recovery crash point"); },
    captureProtocolErrors: false,
  });
  try {
    const root = await runtime.harness.root(context);
    runtime.harness.resume();
    const interrupted = await runtime.harness.submission(config.submissionId, context);
    assert.ok(interrupted, "interrupted submission must survive restart");
    assert.equal((await interrupted.wait(context)).status, "done");
    assert.equal(runtime.expectedReads.length, 1, "replayed edit must consume exactly the published A read");

    const next = await root.submit(
      { type: "input", content: "Continue from the replayed published state." },
      context,
    );
    assert.equal((await next.wait(context)).status, "done");
    assert.deepEqual(runtime.expectedReads, []);

    const binding = await runtime.bindings.readBinding(root.id, context);
    const bytes = await runtime.workspaceClient.readFSLayerFile(
      binding.handle.layerId,
      absoluteWorkspacePath(config.workspaceRoot),
    );
    assert.equal(Buffer.from(bytes).toString("utf8"), FINAL_C);
    const oldLayer = await runtime.workspaceClient.getFSLayer(config.crashLayerId);
    assert.equal(oldLayer.state, "abandoned", "unpublished crash generation must be abandoned");
    return { currentLayerId: binding.handle.layerId };
  } finally {
    await runtime.harness.close(context);
  }
}

async function runVerify(config) {
  const workspaceClient = new Client(config.baseUrl, config.workspaceToken);
  const bytes = await workspaceClient.readFSLayerFile(
    config.currentLayerId,
    absoluteWorkspacePath(config.workspaceRoot),
  );
  assert.equal(Buffer.from(bytes).toString("utf8"), FINAL_C);
  const oldLayer = await workspaceClient.getFSLayer(config.crashLayerId);
  assert.equal(oldLayer.state, "abandoned");
  if (config.crashCheckpointId !== undefined) {
    const checkpoint = await workspaceClient.getFSLayerCheckpoint(config.crashCheckpointId);
    assert.equal(checkpoint.layer_id, config.crashLayerId);
  }

  const stateClient = new Client(config.baseUrl, config.stateToken);
  const storage = await openDrive9SingleCoordinatorStorage(
    {
      client: stateClient,
      stateRoot: config.piStateRoot,
      coordination: "externally-exclusive",
      id: `drive9-state:${config.stateRoot}`,
    },
    context,
  );
  try {
    const entries = await scanEntries(storage, config.conversationId);
    const crashCandidates = entries.filter(
      (entry) =>
        entry.kind === "drive9.workspace-candidate" &&
        entry.data?.checkpoint?.checkpointId === config.crashCheckpointId,
    );
    assert.equal(
      crashCandidates.length,
      config.stage === "candidate" ? 1 : 0,
      "only the candidate crash stage may persist its unpublished candidate",
    );
  } finally {
    await storage.close(context);
  }
  return { verified: true };
}

async function runBreachCreate(config) {
  const runtime = await openRuntime(config, {
    responses: [
      toolCall(
        "edit",
        { path: FILE_NAME, edits: [{ oldText: "published A", newText: "unpublished breach" }] },
        "breach-create",
      ),
      finalAnswer("terminal success whose candidate was not persisted"),
    ],
    expectedReads: [PUBLISHED_A],
    crashStage: undefined,
    storageMode: "drop-candidate",
    crash: async () => { throw new Error("unexpected breach-create crash point"); },
    captureProtocolErrors: false,
  });
  try {
    const root = await runtime.harness.root(context);
    const submission = await root.submit({ type: "input", content: "Create invalid publication." }, context);
    assert.equal((await submission.wait(context)).status, "done");
    assert.equal(runtime.dropped.length, 1, "exactly one candidate must be omitted from durable storage");
    assert.deepEqual(runtime.expectedReads, []);
    return {
      droppedCandidateKey: runtime.dropped[0].candidateKey,
      droppedCheckpointId: runtime.dropped[0].checkpoint.checkpointId,
    };
  } finally {
    await runtime.harness.close(context);
  }
}

async function runBreachVerify(config) {
  const runtime = await openRuntime(config, {
    responses: [
      toolCall(
        "edit",
        { path: FILE_NAME, edits: [{ oldText: "unpublished breach", newText: "must not run" }] },
        "breach-verify",
      ),
      finalAnswer("breach rejected"),
    ],
    expectedReads: [],
    crashStage: undefined,
    storageMode: undefined,
    crash: async () => { throw new Error("unexpected breach-verify crash point"); },
    captureProtocolErrors: true,
  });
  try {
    const root = await runtime.harness.root(context);
    const before = { ...runtime.mutationCounts };
    const submission = await root.submit({ type: "input", content: "This mutation must fail closed." }, context);
    assert.equal((await submission.wait(context)).status, "done");
    assert.ok(runtime.caughtCodes.includes("publication_breach"));
    assert.deepEqual(runtime.mutationCounts, before, "publication breach must cause zero backend mutation");
    assert.deepEqual(runtime.operations, { reads: 0, writes: 0 }, "breach must fail before file access");

    const entries = await scanEntries(runtime.storage, root.id);
    assert.equal(
      entries.some(
        (entry) =>
          entry.kind === "drive9.workspace-candidate" &&
          entry.data?.candidateKey === config.droppedCandidateKey,
      ),
      false,
      "terminal success must lack the dropped candidate in durable state",
    );
    return { code: "publication_breach" };
  } finally {
    await runtime.harness.close(context);
  }
}

async function runWorker() {
  setInterval(() => {}, 60_000);
  const config = JSON.parse(process.env.DRIVE9_PI_CONSUMER_CONFIG ?? "{}");
  try {
    let result;
    switch (role) {
      case "setup": result = await runSetup(config); break;
      case "crash": await runCrash(config); return;
      case "recover": result = await runRecovery(config); break;
      case "verify": result = await runVerify(config); break;
      case "breach-create": result = await runBreachCreate(config); break;
      case "breach-verify": result = await runBreachVerify(config); break;
      default: throw new Error(`unknown worker role ${role}`);
    }
    await message({ type: "result", result });
    process.disconnect?.();
    process.exit(0);
  } catch (error) {
    await message({ type: "failure", error: diagnosticError(error) });
    process.disconnect?.();
    process.exit(1);
  }
}

function spawnWorker(workerRole, config) {
  const workerHome = mkdtempSync(join(config.workerHome, `${workerRole}-`));
  const inherited = {};
  for (const name of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    if (process.env[name] !== undefined) inherited[name] = process.env[name];
  }
  if (apiAddress !== undefined) inherited.DRIVE9_PI_E2E_API_ADDRESS = apiAddress;
  return spawn(process.execPath, [self], {
    env: {
      ...inherited,
      HOME: workerHome,
      XDG_CONFIG_HOME: join(workerHome, ".config"),
      DRIVE9_PI_CONSUMER_ROLE: workerRole,
      DRIVE9_PI_CONSUMER_CONFIG: JSON.stringify(config),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
}

function reportProgress(workerRole, step, previousAt) {
  const now = Date.now();
  process.stdout.write(`[${workerRole}] ${step} (+${now - previousAt}ms)\n`);
  return now;
}

function workerResult(workerRole, config, phaseTimeoutMs = workerPhaseTimeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawnWorker(workerRole, config);
    let result;
    let failure;
    let lastProgress = "worker-started";
    let lastProgressAt = Date.now();
    let lastReport = "none";
    let phaseTimer;
    const armPhaseTimeout = () => {
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => {
        child.kill("SIGKILL");
        failure = new Error(`${workerRole} phase timed out after ${lastProgress}; report=${lastReport}`);
      }, phaseTimeoutMs);
    };
    armPhaseTimeout();
    const totalTimer = setTimeout(() => {
      child.kill("SIGKILL");
      failure = new Error(`${workerRole} worker exceeded its total timeout after ${lastProgress}; report=${lastReport}`);
    }, workerTotalTimeoutMs);
    child.on("message", (event) => {
      if (event?.type === "progress") {
        lastProgress = event.step;
        lastProgressAt = reportProgress(workerRole, lastProgress, lastProgressAt);
        armPhaseTimeout();
      }
      if (event?.type === "report") lastReport = event.error;
      if (event?.type === "result") result = event.result;
      if (event?.type === "failure") {
        failure = new Error(`${workerRole} after ${lastProgress}: ${event.error}`);
        child.kill("SIGKILL");
      }
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("exit", (code, signal) => {
      clearTimeout(phaseTimer);
      clearTimeout(totalTimer);
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      if (code === 0 && result !== undefined) resolve(result);
      else {
        reject(
          new Error(
            `${workerRole} exited code=${String(code)} signal=${String(signal)} after ${lastProgress}; report=${lastReport}`,
          ),
        );
      }
    });
  });
}

function crashWorker(config) {
  return new Promise((resolve, reject) => {
    const child = spawnWorker("crash", config);
    let crashPoint;
    let failure;
    let lastProgress = "worker-started";
    let lastProgressAt = Date.now();
    let phaseTimer;
    const armPhaseTimeout = () => {
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => {
        child.kill("SIGKILL");
        failure = new Error(`${config.stage} crash worker phase timed out after ${lastProgress}`);
      }, workerPhaseTimeoutMs);
    };
    armPhaseTimeout();
    const totalTimer = setTimeout(() => {
      child.kill("SIGKILL");
      failure = new Error(`${config.stage} crash worker exceeded its total timeout after ${lastProgress}`);
    }, workerTotalTimeoutMs);
    child.on("message", (event) => {
      if (event?.type === "progress") {
        lastProgress = event.step;
        lastProgressAt = reportProgress(`${config.stage}-crash`, lastProgress, lastProgressAt);
        armPhaseTimeout();
      }
      if (event?.type === "failure") {
        failure = new Error(`crash worker: ${event.error}`);
        child.kill("SIGKILL");
        return;
      }
      if (event?.type !== "crash-point" || crashPoint !== undefined) return;
      crashPoint = event;
      child.kill("SIGKILL");
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("exit", (code, signal) => {
      clearTimeout(phaseTimer);
      clearTimeout(totalTimer);
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      if (crashPoint !== undefined && signal === "SIGKILL") resolve(crashPoint);
      else reject(new Error(`crash worker exited before SIGKILL code=${String(code)} signal=${String(signal)}`));
    });
  });
}

async function makeScenario(baseUrl, credentials, runRoot, workerHome, label) {
  const workspaceRoot = `${runRoot}/workspace/${label}`;
  const stateRoot = `${runRoot}/state/${label}`;
  const piStateRoot = `${stateRoot}/pi`;
  const bindingPath = `${stateRoot}/bindings/workspace.json`;
  const workspaceClient = new Client(baseUrl, credentials.workspace.token);
  const stateClient = new Client(baseUrl, credentials.state.token);
  await ensureExactDirectory(workspaceClient, workspaceRoot);
  await ensureExactDirectory(stateClient, stateRoot);
  await ensureExactDirectory(stateClient, piStateRoot);
  await ensureExactDirectory(stateClient, posix.dirname(bindingPath));

  const rootLayerId = compactId(`r_${label}_`);
  const root = await workspaceClient.createFSLayer({
    layer_id: rootLayerId,
    base_root_path: workspaceRoot,
    name: `Pi consume ${label}`,
  });
  const rootCheckpointId = checkpointId(`c_${label}_`);
  const rootCheckpoint = await workspaceClient.checkpointFSLayer(root.layer_id, {
    checkpoint_id: rootCheckpointId,
    label: `Pi consume ${label} root`,
  });
  return {
    baseUrl,
    workspaceToken: credentials.workspace.token,
    stateToken: credentials.state.token,
    workerHome,
    workspaceRoot,
    stateRoot,
    piStateRoot,
    bindingPath,
    sessionId: `pi-consume-${label}-${randomUUID()}`,
    writerEpoch: `epoch-${label}-${randomUUID()}`,
    initialCheckpoint: {
      checkpointId: rootCheckpoint.checkpoint_id,
      durableSeq: rootCheckpoint.durable_seq,
      layerId: root.layer_id,
      rootLayerId: root.layer_id,
      parentLayerId: null,
      parentCheckpointId: null,
      depth: 0,
    },
  };
}

async function issueCredentials(owner, runRoot) {
  const issue = async (name, root) =>
    await owner.issueScopedToken({
      subject: `drive9-pi-consume-${name}-${randomUUID()}`,
      ttl_seconds: SCOPED_TOKEN_TTL_SECONDS,
      scopes: [{ prefix: `${root}/`, ops: ["read", "write", "delete", "list"] }],
    });
  return {
    workspace: await issue("workspace", `${runRoot}/workspace`),
    state: await issue("state", `${runRoot}/state`),
    evidence: await issue("evidence", `${runRoot}/evidence`),
  };
}

async function revokeCredentials(owner, credentials) {
  const failures = [];
  for (const token of Object.values(credentials ?? {})) {
    if (token.token_id === undefined) continue;
    try {
      await owner.revokeScopedToken(token.token_id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "scoped token cleanup failed");
}

async function verifyAdditionalIsolation(runRoot, workspaceClient, stateClient, evidenceClient) {
  const directory = `${runRoot}/workspace/.drive9-pi-consume-isolation`;
  const path = `${directory}/${randomUUID()}.probe`;
  const initial = Buffer.from(`workspace-probe:${randomUUID()}`);
  const replacement = Buffer.from(`forbidden-replacement:${randomUUID()}`);
  await ensureExactDirectory(workspaceClient, directory);
  const revision = await workspaceClient.writeWithRevision(path, initial, { expectedRevision: 0 });
  try {
    await requireDenied("state credential workspace write", async () =>
      await stateClient.writeWithRevision(path, replacement, { expectedRevision: revision }));
    await requireDenied("state credential workspace delete", async () =>
      await stateClient.delete(path));
    await requireDenied("evidence credential workspace write", async () =>
      await evidenceClient.writeWithRevision(path, replacement, { expectedRevision: revision }));
    await requireDenied("evidence credential workspace delete", async () =>
      await evidenceClient.delete(path));
    assert.equal(Buffer.from(await workspaceClient.read(path)).toString("utf8"), initial.toString("utf8"));
  } finally {
    await workspaceClient.delete(path);
  }
}

async function cleanupRun(owner, runRoot) {
  const failures = [];
  try {
    const layers = (await owner.listFSLayers()).filter(
      (layer) => layer.base_root_path === `${runRoot}/workspace` || layer.base_root_path.startsWith(`${runRoot}/workspace/`),
    );
    const roots = layers.filter((layer) => !layer.parent_layer_id);
    for (const layer of roots) {
      try {
        await owner.deleteFSLayer(layer.layer_id, { cascade: true });
      } catch (error) {
        if (statusCode(error) !== 404) failures.push(error);
      }
    }
    const remaining = (await owner.listFSLayers()).filter(
      (layer) =>
        (layer.base_root_path === `${runRoot}/workspace` || layer.base_root_path.startsWith(`${runRoot}/workspace/`)) &&
        layer.state !== "abandoned",
    );
    if (remaining.length > 0) failures.push(new Error("cleanup left active LayerFS generations"));
  } catch (error) {
    failures.push(error);
  }
  try {
    await owner.removeAll(runRoot);
  } catch (error) {
    if (statusCode(error) !== 404) failures.push(error);
  }
  if (failures.length > 0) throw new AggregateError(failures, "consume-chain cleanup failed");
}

async function runController() {
  const owner = Client.defaultClient();
  try {
    await owner.warm();
    await owner.listFSLayers();
  } catch (error) {
    if (required) throw new Error("authenticated real Drive9 backend is unavailable", { cause: error });
    process.stdout.write("SKIP: authenticated real Drive9 backend unavailable\n");
    return;
  }

  const runRoot = `/drive9-pi-consume/${Date.now()}-${randomUUID()}`;
  const workerHome = await mkdtemp(join(tmpdir(), "drive9-pi-consume-worker-"));
  let credentials;
  let runError;
  try {
    await ensureDirectory(owner, `${runRoot}/workspace`);
    await ensureDirectory(owner, `${runRoot}/state`);
    await ensureDirectory(owner, `${runRoot}/evidence`);
    credentials = await issueCredentials(owner, runRoot);

    const workspaceClient = new Client(owner.baseUrl, credentials.workspace.token);
    const stateClient = new Client(owner.baseUrl, credentials.state.token);
    const evidenceClient = new Client(owner.baseUrl, credentials.evidence.token);
    const isolation = await verifyRuntimeIsolation({
      workspaceRemoteRoot: `${runRoot}/workspace`,
      stateRemoteRoot: `${runRoot}/state`,
      evidenceRemoteRoot: `${runRoot}/evidence`,
      workspaceClient,
      stateClient,
      evidenceClient,
      workspaceEvidenceRead: "deny",
    });
    assert.deepEqual(
      { ...isolation, verifiedAt: "timestamp" },
      {
        rootsDisjoint: true,
        workspaceCreateReadReplaceDelete: true,
        stateCreateReadReplaceDelete: true,
        evidenceCreateReadReplaceDelete: true,
        workspaceStateReadDenied: true,
        workspaceStateWriteDenied: true,
        workspaceStateDeleteDenied: true,
        workspaceEvidenceRead: "denied",
        workspaceEvidenceWriteDenied: true,
        workspaceEvidenceDeleteDenied: true,
        stateWorkspaceWriteDenied: true,
        stateWorkspaceDeleteDenied: true,
        evidenceStateWriteDenied: true,
        evidenceStateDeleteDenied: true,
        verifiedAt: "timestamp",
      },
    );
    await verifyAdditionalIsolation(runRoot, workspaceClient, stateClient, evidenceClient);

    for (const stage of ["dirty", "checkpoint", "candidate"]) {
      const scenario = await makeScenario(owner.baseUrl, credentials, runRoot, workerHome, stage);
      const setup = await workerResult("setup", scenario);
      const crash = await crashWorker({ ...scenario, ...setup, stage });
      const recovered = await workerResult("recover", {
        ...scenario,
        ...setup,
        stage,
        submissionId: crash.submissionId,
        crashLayerId: crash.layerId,
      });
      await workerResult("verify", {
        ...scenario,
        ...setup,
        ...recovered,
        stage,
        crashLayerId: crash.layerId,
        ...(crash.checkpointId === undefined ? {} : { crashCheckpointId: crash.checkpointId }),
      });
      process.stdout.write(`PASS: ${stage} SIGKILL restored published bytes and excluded unpublished effects\n`);
    }

    const breach = await makeScenario(owner.baseUrl, credentials, runRoot, workerHome, "breach");
    const breachSetup = await workerResult("setup", breach);
    const invalid = await workerResult("breach-create", { ...breach, ...breachSetup });
    const rejected = await workerResult("breach-verify", {
      ...breach,
      ...breachSetup,
      ...invalid,
    });
    assert.equal(rejected.code, "publication_breach");
    process.stdout.write("PASS: terminal success without durable candidate fails closed as publication_breach\n");
    process.stdout.write("PASS: clean-package Pi Harness + Drive9 0.2.0 consume-chain crash gate\n");
  } catch (error) {
    runError = error;
  }

  const cleanupErrors = [];
  try {
    await cleanupRun(owner, runRoot);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await revokeCredentials(owner, credentials);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rm(workerHome, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (runError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([runError, ...cleanupErrors], "gate and cleanup failed");
  }
  if (runError !== undefined) throw runError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "cleanup failed");
}

if (role === "controller") {
  await runController();
} else {
  await runWorker();
}
