import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import { Drive9ProtocolError } from "./errors.js";

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Drive9ProtocolError("invalid_protocol_record", "value is not JSON serializable");
    }
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

export function sha256Hex(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function prefixedDigest(prefix: string, value: JsonValue): string {
  if (!/^[a-z][a-z0-9_]*_$/.test(prefix) || prefix.length >= 64) {
    throw new Drive9ProtocolError("invalid_protocol_record", "digest prefix is invalid");
  }
  return `${prefix}${sha256Hex(value).slice(0, 64 - prefix.length)}`;
}
