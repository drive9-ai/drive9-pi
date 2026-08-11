import { createHash } from "node:crypto";
import { ResultStoreError, type ToolResultIdentity } from "./tool-result-types.js";

const RESULT_ID_MAGIC = Buffer.from("drive9-pi/result-id/v1\0", "utf8");

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function encodeField(value: string, field: string): Buffer {
  if (value.length === 0 || hasUnpairedSurrogate(value)) {
    throw new ResultStoreError("invalid", `${field} must be a non-empty UTF-8 string`);
  }
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > 0xffff_ffff) {
    throw new ResultStoreError("limit_exceeded", `${field} exceeds the result identity limit`);
  }
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(encoded.length);
  return Buffer.concat([length, encoded]);
}

export function encodeResultIdentity(identity: ToolResultIdentity): Uint8Array {
  if (
    typeof identity !== "object" ||
    identity === null ||
    typeof identity.sessionId !== "string" ||
    typeof identity.runId !== "string" ||
    typeof identity.toolCallId !== "string"
  ) {
    throw new ResultStoreError("invalid", "result identity must contain string identifiers");
  }
  if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 0) {
    throw new ResultStoreError("invalid", "attempt must be a non-negative safe integer");
  }
  const attempt = Buffer.allocUnsafe(8);
  attempt.writeBigUInt64BE(BigInt(identity.attempt));
  return Buffer.concat([
    RESULT_ID_MAGIC,
    encodeField(identity.sessionId, "sessionId"),
    encodeField(identity.runId, "runId"),
    encodeField(identity.toolCallId, "toolCallId"),
    attempt,
  ]);
}

export function deriveResultId(identity: ToolResultIdentity): string {
  const digest = createHash("sha256").update(encodeResultIdentity(identity)).digest("hex");
  return `r1_${digest}`;
}
