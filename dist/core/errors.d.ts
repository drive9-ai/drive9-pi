export type Drive9ProtocolErrorCode = "candidate_commit_unknown" | "candidate_conflict" | "checkpoint_mismatch" | "execution_env_mismatch" | "invalid_protocol_record" | "layer_depth_exhausted" | "publication_breach" | "recovery_failed" | "session_poisoned" | "stable_storage_required";
export declare class Drive9ProtocolError extends Error {
    readonly code: Drive9ProtocolErrorCode;
    constructor(code: Drive9ProtocolErrorCode, message: string, cause?: Error);
}
export declare function protocolCause(value: unknown): Error;
//# sourceMappingURL=errors.d.ts.map