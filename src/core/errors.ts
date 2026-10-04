export type Drive9ProtocolErrorCode =
  | "candidate_commit_unknown"
  | "candidate_conflict"
  | "checkpoint_mismatch"
  | "execution_env_mismatch"
  | "invalid_protocol_record"
  | "layer_depth_exhausted"
  | "publication_breach"
  | "recovery_failed"
  | "session_already_open"
  | "session_lease_lost"
  | "session_lease_unavailable"
  | "session_poisoned"
  | "stable_storage_required";

export class Drive9ProtocolError extends Error {
  readonly code: Drive9ProtocolErrorCode;

  constructor(code: Drive9ProtocolErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "Drive9ProtocolError";
    this.code = code;
  }
}

export function protocolCause(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
