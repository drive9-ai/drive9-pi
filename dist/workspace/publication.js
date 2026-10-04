import { ToolResultEntry, } from "@earendil-works/pi-durable";
import { Drive9ProtocolError, protocolCause } from "../core/errors.js";
import { canonicalJson } from "../core/identity.js";
import { WorkspaceAttemptEntry, WorkspaceCandidateEntry, parseWorkspaceAttemptData, parseWorkspaceCandidateData } from "./entries.js";
const PAGE_SIZE = 256;
function protocolBreach(message) {
    throw new Drive9ProtocolError("publication_breach", message);
}
function taskIdOf(entry) {
    return entry.byTaskId;
}
function sameTask(left, right) {
    return left !== undefined && Number(left) === Number(right);
}
function taskResultEntryId(task) {
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
function attemptFromEntry(entry, taskId, toolCallId) {
    if (!sameTask(taskIdOf(entry), taskId) || !WorkspaceAttemptEntry.is(entry))
        return undefined;
    const attempt = parseWorkspaceAttemptData(entry.data);
    if (attempt.taskId !== Number(taskId))
        protocolBreach("workspace attempt task identity does not match attribution");
    if (attempt.toolCallId !== toolCallId)
        protocolBreach("workspace attempt tool call does not match its result");
    return attempt;
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
function requireCandidates(entries, resultIndex, attemptIndex, attemptEntryId, attempt, taskId) {
    const logical = [];
    for (let index = resultIndex + 1; index < attemptIndex; index += 1) {
        const entry = entries[index];
        if (!sameTask(taskIdOf(entry), taskId) || !WorkspaceCandidateEntry.is(entry))
            continue;
        const candidate = parseWorkspaceCandidateData(entry.data);
        if (candidate.taskId !== Number(taskId))
            protocolBreach("workspace candidate task identity does not match attribution");
        if (candidate.attemptId !== Number(attemptEntryId)) {
            protocolBreach("workspace candidate belongs to a stale or different attempt");
        }
        if (canonicalJson(attemptFields(candidate)) !== canonicalJson(attempt)) {
            protocolBreach("workspace candidate does not match its attempt");
        }
        logical.push({ entry, data: candidate });
    }
    if (logical.length === 0)
        protocolBreach("successful workspace attempt has no candidate");
    const selected = logical[0];
    const selectedPayload = canonicalJson(selected.data);
    for (const duplicate of logical.slice(1)) {
        if (duplicate.data.candidateKey !== selected.data.candidateKey) {
            throw new Drive9ProtocolError("candidate_conflict", "one workspace attempt has multiple candidate keys");
        }
        if (canonicalJson(duplicate.data) !== selectedPayload) {
            throw new Drive9ProtocolError("candidate_conflict", "duplicate workspace candidate payloads conflict");
        }
    }
    return selected;
}
function exactCheckpoint(left, right) {
    return canonicalJson(left) === canonicalJson(right);
}
async function requireVisiblePublicationEntries(storage, conversationId, sourceConversationId, entries, context) {
    for (const entry of entries) {
        if (Number(entry.conversationId) !== sourceConversationId) {
            protocolBreach("workspace publication entries cross conversation boundaries");
        }
        const visible = await storage.entry(conversationId, entry.id, context);
        if (visible === undefined ||
            canonicalJson(visible.entry) !== canonicalJson(entry)) {
            protocolBreach("workspace publication entry is not visible from the target conversation");
        }
    }
}
function publishedRef(candidate) {
    return {
        candidateKey: candidate.data.candidateKey,
        checkpointId: candidate.data.checkpoint.checkpointId,
        durableSeq: candidate.data.checkpoint.durableSeq,
        layerId: candidate.data.checkpoint.layerId,
        rootLayerId: candidate.data.checkpoint.rootLayerId,
        depth: candidate.data.checkpoint.depth,
    };
}
function exactPrevious(recorded, previous) {
    const expected = previous === undefined ? null : publishedRef(previous);
    return canonicalJson(recorded) === canonicalJson(expected);
}
async function visibleEntries(storage, conversationId, cutoff, context) {
    const entries = [];
    let cursor;
    do {
        const query = cutoff === undefined ? { conversationId } : { conversationId, maxEntryId: cutoff };
        const page = await storage.scanEntries(query, PAGE_SIZE, cursor, context);
        entries.push(...page.items);
        cursor = page.next;
    } while (cursor !== undefined);
    return entries;
}
export async function resolvePublishedWorkspace(input) {
    const entries = await visibleEntries(input.storage, input.conversationId, input.cutoff, input.context);
    return resolveFromIndex(entries, 0, input);
}
async function resolveFromIndex(entries, startIndex, input) {
    for (let resultIndex = startIndex; resultIndex < entries.length; resultIndex += 1) {
        const resultEntry = entries[resultIndex];
        const result = toolResult(resultEntry);
        const taskId = taskIdOf(resultEntry);
        if (result === undefined || taskId === undefined)
            continue;
        let attemptIndex = -1;
        let attempt;
        for (let index = resultIndex + 1; index < entries.length; index += 1) {
            const candidate = attemptFromEntry(entries[index], taskId, result.toolCallId);
            if (candidate === undefined)
                continue;
            attemptIndex = index;
            attempt = candidate;
            break;
        }
        if (attempt === undefined)
            continue;
        const task = await input.storage.task(taskId, input.context);
        if (task === undefined || task.kind !== "pi.tool")
            protocolBreach("workspace result has no matching Pi ToolTask");
        if (task.state.status !== "terminal")
            protocolBreach("workspace result is visible before its ToolTask is terminal");
        if (task.state.outcome.status !== "completed" || result.isError)
            continue;
        if (taskResultEntryId(task) !== Number(resultEntry.id)) {
            protocolBreach("ToolTask completion does not identify the visible result entry");
        }
        if (attempt.conversationId !== Number(task.conversationId)) {
            protocolBreach("workspace attempt conversation does not match its ToolTask");
        }
        const selected = requireCandidates(entries, resultIndex, attemptIndex, entries[attemptIndex].id, attempt, taskId);
        await requireVisiblePublicationEntries(input.storage, input.conversationId, attempt.conversationId, [entries[attemptIndex], selected.entry, resultEntry], input.context);
        let verified;
        try {
            verified = await input.verifier.verify(selected.data, input.context);
        }
        catch (error) {
            if (error instanceof Drive9ProtocolError)
                throw error;
            const cause = protocolCause(error);
            throw new Drive9ProtocolError("checkpoint_mismatch", cause.message, cause);
        }
        if (!exactCheckpoint(verified, selected.data.checkpoint)) {
            throw new Drive9ProtocolError("checkpoint_mismatch", "Drive9 checkpoint verification returned different lineage");
        }
        const published = {
            attemptEntryId: entries[attemptIndex].id,
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
//# sourceMappingURL=publication.js.map