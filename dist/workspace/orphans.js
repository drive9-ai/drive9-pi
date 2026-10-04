import { ToolResultEntry, } from "@earendil-works/pi-durable";
import { Drive9ProtocolError, protocolCause } from "../core/errors.js";
import { canonicalJson } from "../core/identity.js";
import { WorkspaceAttemptEntry, WorkspaceCandidateEntry, parseWorkspaceAttemptData, parseWorkspaceCandidateData } from "./entries.js";
import { resolvePublishedWorkspace } from "./publication.js";
const PAGE_SIZE = 256;
function protocolBreach(message) {
    throw new Drive9ProtocolError("publication_breach", message);
}
function taskIdOf(entry) {
    return entry.byTaskId === undefined ? undefined : Number(entry.byTaskId);
}
function sameJson(left, right) {
    return canonicalJson(left) === canonicalJson(right);
}
function attemptFields(candidate) {
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
function publishedRef(candidate) {
    return {
        candidateKey: candidate.candidateKey,
        checkpointId: candidate.checkpoint.checkpointId,
        durableSeq: candidate.checkpoint.durableSeq,
        layerId: candidate.checkpoint.layerId,
        rootLayerId: candidate.checkpoint.rootLayerId,
        depth: candidate.checkpoint.depth,
    };
}
async function visibleEntries(input) {
    const entries = [];
    let cursor;
    do {
        const query = input.cutoff === undefined
            ? { conversationId: input.conversationId }
            : { conversationId: input.conversationId, maxEntryId: input.cutoff };
        const page = await input.storage.scanEntries(query, PAGE_SIZE, cursor, input.context);
        entries.push(...page.items);
        cursor = page.next;
    } while (cursor !== undefined);
    return entries;
}
function candidateGroups(entries) {
    const groups = new Map();
    for (const entry of entries) {
        if (!WorkspaceCandidateEntry.is(entry))
            continue;
        const data = parseWorkspaceCandidateData(entry.data);
        const existing = groups.get(data.candidateKey);
        if (existing === undefined) {
            groups.set(data.candidateKey, { data, entries: [entry] });
            continue;
        }
        if (!sameJson(existing.data, data)) {
            throw new Drive9ProtocolError("candidate_conflict", "duplicate workspace candidate payloads conflict");
        }
        existing.entries.push(entry);
    }
    return groups;
}
function publishedKeys(published, groups) {
    const keys = new Set();
    let current = published?.data;
    while (current !== undefined) {
        if (keys.has(current.candidateKey))
            protocolBreach("published workspace chain contains a cycle");
        keys.add(current.candidateKey);
        const previous = current.previous;
        if (previous === null)
            break;
        const group = groups.get(previous.candidateKey);
        if (group === undefined)
            protocolBreach("published workspace chain references a missing candidate");
        if (!sameJson(publishedRef(group.data), previous)) {
            protocolBreach("published workspace chain reference does not match its candidate");
        }
        current = group.data;
    }
    return keys;
}
function attemptDisposition(group, entriesById) {
    const candidate = group.data;
    if (group.entries.some((entry) => Number(entry.conversationId) !== candidate.conversationId ||
        taskIdOf(entry) !== candidate.taskId)) {
        return { kind: "unresolved", reason: "candidate-entry-mismatch" };
    }
    const attemptEntry = entriesById.get(candidate.attemptId);
    if (attemptEntry === undefined)
        return { kind: "unresolved", reason: "attempt-not-visible" };
    if (!WorkspaceAttemptEntry.is(attemptEntry) ||
        Number(attemptEntry.conversationId) !== candidate.conversationId ||
        taskIdOf(attemptEntry) !== candidate.taskId) {
        return { kind: "unresolved", reason: "attempt-mismatch" };
    }
    const attempt = parseWorkspaceAttemptData(attemptEntry.data);
    if (!sameJson(attempt, attemptFields(candidate))) {
        return { kind: "unresolved", reason: "attempt-mismatch" };
    }
    return undefined;
}
function resultEntryId(task) {
    if (task.state.status !== "terminal" || task.state.outcome.status !== "completed")
        return undefined;
    const result = task.state.outcome.result;
    if (typeof result !== "object" || result === null || Array.isArray(result))
        return undefined;
    const entryId = result.entryId;
    return Number.isSafeInteger(entryId) && entryId > 0 ? entryId : undefined;
}
function toolResult(entry) {
    if (!ToolResultEntry.is(entry))
        return undefined;
    const message = entry.model?.[0];
    if (message?.role !== "toolResult")
        return undefined;
    return { toolCallId: message.toolCallId, isError: message.isError };
}
async function disposition(input) {
    const candidate = input.group.data;
    if (input.inventory.expectedSessionId !== undefined && candidate.sessionId !== input.inventory.expectedSessionId) {
        return { kind: "unresolved", reason: "session-mismatch" };
    }
    const attemptProblem = attemptDisposition(input.group, input.entriesById);
    if (attemptProblem !== undefined)
        return attemptProblem;
    if (input.publishedKeys.has(candidate.candidateKey)) {
        return { kind: "published", reason: "published-chain" };
    }
    const task = await input.inventory.storage.task(candidate.taskId, input.inventory.context);
    if (task === undefined)
        return { kind: "unresolved", reason: "task-missing" };
    if (task.kind !== "pi.tool" ||
        Number(task.conversationId) !== candidate.conversationId ||
        Number(task.id) !== candidate.taskId) {
        return { kind: "unresolved", reason: "task-kind-mismatch" };
    }
    if (task.state.status === "pending" || task.state.status === "running" || task.state.status === "waiting") {
        return { kind: "unresolved", reason: "task-active" };
    }
    if (task.state.status === "completing") {
        return { kind: "unresolved", reason: "task-completing" };
    }
    const outcome = task.state.outcome;
    if (outcome.status !== "completed") {
        return { kind: "permanently-unpublishable", reason: `task-terminal-${outcome.status}` };
    }
    const entryId = resultEntryId(task);
    if (entryId === undefined)
        return { kind: "unresolved", reason: "terminal-result-invalid" };
    const resultEntry = input.entriesById.get(entryId);
    if (resultEntry === undefined)
        return { kind: "unresolved", reason: "terminal-result-not-visible" };
    const result = toolResult(resultEntry);
    if (result === undefined ||
        taskIdOf(resultEntry) !== candidate.taskId ||
        Number(resultEntry.conversationId) !== candidate.conversationId ||
        result.toolCallId !== candidate.toolCallId) {
        return { kind: "unresolved", reason: "terminal-result-mismatch" };
    }
    if (result.isError)
        return { kind: "permanently-unpublishable", reason: "tool-result-error" };
    return { kind: "permanently-unpublishable", reason: "terminal-success-not-selected" };
}
export async function inspectWorkspaceCandidateInventory(input) {
    const entries = await visibleEntries(input);
    const entriesById = new Map(entries.map((entry) => [Number(entry.id), entry]));
    const groups = candidateGroups(entries);
    const published = await resolvePublishedWorkspace(input);
    const chain = publishedKeys(published, groups);
    const items = [];
    for (const group of groups.values()) {
        const itemDisposition = await disposition({ inventory: input, group, entriesById, publishedKeys: chain });
        items.push({
            candidateKey: group.data.candidateKey,
            checkpointId: group.data.checkpoint.checkpointId,
            durableSeq: group.data.checkpoint.durableSeq,
            layerId: group.data.checkpoint.layerId,
            rootLayerId: group.data.checkpoint.rootLayerId,
            sessionId: group.data.sessionId,
            sourceConversationId: group.data.conversationId,
            taskId: group.data.taskId,
            toolCallId: group.data.toolCallId,
            attemptId: group.data.attemptId,
            candidateEntryIds: group.entries.map((entry) => entry.id),
            disposition: itemDisposition,
        });
    }
    const publishedCount = items.filter((item) => item.disposition.kind === "published").length;
    const permanentlyUnpublishableCount = items.filter((item) => item.disposition.kind === "permanently-unpublishable").length;
    const unresolvedCount = items.filter((item) => item.disposition.kind === "unresolved").length;
    return {
        conversationId: input.conversationId,
        ...(input.cutoff === undefined ? {} : { cutoff: input.cutoff }),
        publishedCandidateKey: published?.data.candidateKey ?? null,
        candidateRecordCount: [...groups.values()].reduce((count, group) => count + group.entries.length, 0),
        uniqueCandidateCount: groups.size,
        publishedCount,
        permanentlyUnpublishableCount,
        unresolvedCount,
        requiresAttention: permanentlyUnpublishableCount > 0 || unresolvedCount > 0,
        items,
    };
}
export async function reportWorkspaceCandidateInventory(input) {
    const inventory = await inspectWorkspaceCandidateInventory(input);
    try {
        await input.report(inventory, input.context);
    }
    catch (error) {
        try {
            await input.onReportError?.(protocolCause(error));
        }
        catch { }
    }
    return inventory;
}
//# sourceMappingURL=orphans.js.map