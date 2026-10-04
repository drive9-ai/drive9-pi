import type { Context, JsonValue } from "@earendil-works/chord";
import {
  ToolResultEntry,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Storage,
  type TaskId,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { Drive9ProtocolError, protocolCause } from "../core/errors.js";
import { canonicalJson } from "../core/identity.js";
import { WorkspaceAttemptEntry, WorkspaceCandidateEntry, parseWorkspaceAttemptData, parseWorkspaceCandidateData } from "./entries.js";
import type {
  PublishedWorkspaceCandidate,
  PublishedWorkspaceRef,
  VerifiedWorkspaceCheckpoint,
  WorkspaceAttemptData,
  WorkspaceCandidateData,
  WorkspaceCandidateVerifier,
} from "./types.js";

const PAGE_SIZE = 256;

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

function protocolBreach(message: string): never {
  throw new Drive9ProtocolError("publication_breach", message);
}

function taskIdOf(entry: EntryRecord): TaskId | undefined {
  return entry.byTaskId;
}

function sameTask(left: TaskId | undefined, right: TaskId): boolean {
  return left !== undefined && Number(left) === Number(right);
}

function taskResultEntryId(task: StoredTask): number | undefined {
  if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") return undefined;
  const result = task.state.outcome.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
  const entryId = result.entryId;
  return Number.isSafeInteger(entryId) && (entryId as number) > 0 ? (entryId as number) : undefined;
}

function toolResult(entry: EntryRecord): { readonly toolCallId: string; readonly isError: boolean } | undefined {
  if (!ToolResultEntry.is(entry)) return undefined;
  const message = entry.model?.[0];
  if (message?.role !== "toolResult") return undefined;
  return { toolCallId: message.toolCallId, isError: message.isError };
}

function attemptFromEntry(entry: EntryRecord, taskId: TaskId, toolCallId: string): WorkspaceAttemptData | undefined {
  if (!sameTask(taskIdOf(entry), taskId) || !WorkspaceAttemptEntry.is(entry)) return undefined;
  const attempt = parseWorkspaceAttemptData(entry.data);
  if (attempt.taskId !== Number(taskId)) protocolBreach("workspace attempt task identity does not match attribution");
  if (attempt.toolCallId !== toolCallId) protocolBreach("workspace attempt tool call does not match its result");
  return attempt;
}

function attemptFields(candidate: WorkspaceCandidateData): WorkspaceAttemptData {
  return {
    protocolVersion: candidate.protocolVersion,
    sessionId: candidate.sessionId,
    conversationId: candidate.conversationId,
    taskId: candidate.taskId,
    toolCallId: candidate.toolCallId,
    writerEpoch: candidate.writerEpoch,
    effect: candidate.effect,
    workspace: candidate.workspace,
    previous: candidate.previous,
  };
}

function requireCandidates(
  entries: readonly EntryRecord[],
  resultIndex: number,
  attemptIndex: number,
  attemptEntryId: EntryId,
  attempt: WorkspaceAttemptData,
  taskId: TaskId,
): { readonly entry: EntryRecord; readonly data: WorkspaceCandidateData } {
  const logical: { entry: EntryRecord; data: WorkspaceCandidateData }[] = [];
  for (let index = resultIndex + 1; index < attemptIndex; index += 1) {
    const entry = entries[index]!;
    if (!sameTask(taskIdOf(entry), taskId) || !WorkspaceCandidateEntry.is(entry)) continue;
    const candidate = parseWorkspaceCandidateData(entry.data);
    if (candidate.taskId !== Number(taskId)) protocolBreach("workspace candidate task identity does not match attribution");
    if (candidate.attemptId !== Number(attemptEntryId)) {
      protocolBreach("workspace candidate belongs to a stale or different attempt");
    }
    if (canonicalJson(attemptFields(candidate) as JsonValue) !== canonicalJson(attempt as JsonValue)) {
      protocolBreach("workspace candidate does not match its attempt");
    }
    logical.push({ entry, data: candidate });
  }
  if (logical.length === 0) protocolBreach("successful workspace attempt has no candidate");
  const selected = logical[0]!;
  const selectedPayload = canonicalJson(selected.data as JsonValue);
  for (const duplicate of logical.slice(1)) {
    if (duplicate.data.candidateKey !== selected.data.candidateKey) {
      throw new Drive9ProtocolError("candidate_conflict", "one workspace attempt has multiple candidate keys");
    }
    if (canonicalJson(duplicate.data as JsonValue) !== selectedPayload) {
      throw new Drive9ProtocolError("candidate_conflict", "duplicate workspace candidate payloads conflict");
    }
  }
  return selected;
}

function exactCheckpoint(left: VerifiedWorkspaceCheckpoint, right: VerifiedWorkspaceCheckpoint): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
}

async function requireVisiblePublicationEntries(
  storage: Storage,
  conversationId: ConversationId,
  sourceConversationId: number,
  entries: readonly EntryRecord[],
  context: Context,
): Promise<void> {
  for (const entry of entries) {
    if (Number(entry.conversationId) !== sourceConversationId) {
      protocolBreach("workspace publication entries cross conversation boundaries");
    }
    const visible = await storage.entry(conversationId, entry.id, context);
    if (
      visible === undefined ||
      canonicalJson(visible.entry as unknown as JsonValue) !== canonicalJson(entry as unknown as JsonValue)
    ) {
      protocolBreach("workspace publication entry is not visible from the target conversation");
    }
  }
}

function publishedRef(candidate: PublishedWorkspaceCandidate): PublishedWorkspaceRef {
  return {
    candidateKey: candidate.data.candidateKey,
    checkpointId: candidate.data.checkpoint.checkpointId,
    durableSeq: candidate.data.checkpoint.durableSeq,
    layerId: candidate.data.checkpoint.layerId,
    rootLayerId: candidate.data.checkpoint.rootLayerId,
    depth: candidate.data.checkpoint.depth,
  };
}

function exactPrevious(
  recorded: PublishedWorkspaceRef | null,
  previous: PublishedWorkspaceCandidate | undefined,
): boolean {
  const expected = previous === undefined ? null : publishedRef(previous);
  return canonicalJson(recorded as JsonValue) === canonicalJson(expected as JsonValue);
}

async function visibleEntries(
  storage: Storage,
  conversationId: ConversationId,
  cutoff: EntryId | undefined,
  context: Context,
): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const query = cutoff === undefined ? { conversationId } : { conversationId, maxEntryId: cutoff };
    const page = await storage.scanEntries(query, PAGE_SIZE, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
}

export async function resolvePublishedWorkspace(input: {
  readonly storage: Storage;
  readonly conversationId: ConversationId;
  readonly cutoff?: EntryId;
  readonly verifier: WorkspaceCandidateVerifier;
  readonly context: Context;
}): Promise<PublishedWorkspaceCandidate | undefined> {
  const entries = await visibleEntries(input.storage, input.conversationId, input.cutoff, input.context);
  return resolveFromIndex(entries, 0, input);
}

async function resolveFromIndex(
  entries: readonly EntryRecord[],
  startIndex: number,
  input: {
    readonly storage: Storage;
    readonly conversationId: ConversationId;
    readonly verifier: WorkspaceCandidateVerifier;
    readonly context: Context;
  },
): Promise<PublishedWorkspaceCandidate | undefined> {
  for (let resultIndex = startIndex; resultIndex < entries.length; resultIndex += 1) {
    const resultEntry = entries[resultIndex]!;
    const result = toolResult(resultEntry);
    const taskId = taskIdOf(resultEntry);
    if (result === undefined || taskId === undefined) continue;

    let attemptIndex = -1;
    let attempt: WorkspaceAttemptData | undefined;
    for (let index = resultIndex + 1; index < entries.length; index += 1) {
      const candidate = attemptFromEntry(entries[index]!, taskId, result.toolCallId);
      if (candidate === undefined) continue;
      attemptIndex = index;
      attempt = candidate;
      break;
    }
    if (attempt === undefined) continue;

    const task = await input.storage.task(taskId, input.context);
    if (task === undefined || task.kind !== "pi.tool") protocolBreach("workspace result has no matching Pi ToolTask");
    if (task.state.status !== "terminal") protocolBreach("workspace result is visible before its ToolTask is terminal");
    if (task.state.outcome.status !== "completed" || result.isError) continue;
    if (taskResultEntryId(task) !== Number(resultEntry.id)) {
      protocolBreach("ToolTask completion does not identify the visible result entry");
    }
    if (attempt.conversationId !== Number(task.conversationId)) {
      protocolBreach("workspace attempt conversation does not match its ToolTask");
    }

    const selected = requireCandidates(
      entries,
      resultIndex,
      attemptIndex,
      entries[attemptIndex]!.id,
      attempt,
      taskId,
    );
    await requireVisiblePublicationEntries(
      input.storage,
      input.conversationId,
      attempt.conversationId,
      [entries[attemptIndex]!, selected.entry, resultEntry],
      input.context,
    );
    let verified: VerifiedWorkspaceCheckpoint;
    try {
      verified = await input.verifier.verify(selected.data, input.context);
    } catch (error) {
      if (error instanceof Drive9ProtocolError) throw error;
      const cause = protocolCause(error);
      throw new Drive9ProtocolError("checkpoint_mismatch", cause.message, cause);
    }
    if (!exactCheckpoint(verified, selected.data.checkpoint)) {
      throw new Drive9ProtocolError("checkpoint_mismatch", "Drive9 checkpoint verification returned different lineage");
    }
    const published: PublishedWorkspaceCandidate = {
      attemptEntryId: entries[attemptIndex]!.id,
      candidateEntryId: selected.entry.id,
      resultEntryId: resultEntry.id,
      taskId,
      data: selected.data,
    };
    const previous = await resolveFromIndex(entries, attemptIndex + 1, input);
    if (!exactPrevious(published.data.previous, previous)) {
      protocolBreach("workspace candidate previous head does not match the published chain");
    }
    return published;
  }
  return undefined;
}
