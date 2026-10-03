import { Drive9ProtocolError, protocolCause } from "../core/errors.js";
import { WorkspaceAttemptEntry, WorkspaceCandidateEntry, buildWorkspaceAttemptData, buildWorkspaceCandidateData, deriveWorkspaceCandidateKey, } from "./entries.js";
import { defaultDrive9Effect, drive9ReplayPolicy } from "./effect-policy.js";
async function executeWorkspaceTool(tool, effect, coordinator, args, api, context) {
    const plan = await coordinator.prepare({
        conversationId: api.conversationId,
        taskId: api.taskId,
        toolCallId: api.callId,
        effect,
        env: api.env,
    }, context);
    const attempt = buildWorkspaceAttemptData({
        conversationId: Number(api.conversationId),
        taskId: Number(api.taskId),
        toolCallId: api.callId,
        effect,
        plan,
    });
    const attemptEntry = await api.commit((tx) => tx.appendEntry(WorkspaceAttemptEntry, api.conversationId, { data: attempt }), context);
    let result;
    try {
        result = await tool.execute(args, api, context);
    }
    catch (error) {
        coordinator.invalidate(plan);
        throw error;
    }
    if (result.isError === true) {
        coordinator.invalidate(plan);
        return result;
    }
    const checkpointId = deriveWorkspaceCandidateKey(attempt, attemptEntry.id);
    let candidate;
    try {
        const checkpoint = await coordinator.checkpointAndVerify({
            checkpointId,
            attemptId: attemptEntry.id,
            conversationId: api.conversationId,
            taskId: api.taskId,
            toolCallId: api.callId,
            effect,
            plan,
        }, context);
        candidate = buildWorkspaceCandidateData({ attempt, attemptId: attemptEntry.id, checkpoint });
    }
    catch (error) {
        coordinator.invalidate(plan);
        throw error;
    }
    try {
        await api.commit((tx) => tx.appendEntry(WorkspaceCandidateEntry, api.conversationId, { data: candidate }), context);
    }
    catch (error) {
        coordinator.invalidate(plan);
        const cause = protocolCause(error);
        return coordinator.poison(new Drive9ProtocolError("candidate_commit_unknown", "workspace candidate commit outcome is unknown; the current session is poisoned", cause), context);
    }
    return result;
}
export function withDrive9Effects(tool, options) {
    const effect = options.effect ?? defaultDrive9Effect(tool.name, true);
    if (effect === "none")
        return tool;
    if (effect === "external")
        return { ...tool, replay: "unsafe" };
    return {
        ...tool,
        replay: drive9ReplayPolicy(effect),
        executionMode: "sequential",
        execute: async (args, api, context) => executeWorkspaceTool(tool, effect, options.coordinator, args, api, context),
    };
}
//# sourceMappingURL=wrap-tool.js.map