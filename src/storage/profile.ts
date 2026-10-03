import type { Storage } from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../core/errors.js";

export type Drive9StorageProfile =
  | {
      readonly kind: "server-fenced";
      readonly protocol: "drive9.writer-epoch/v1";
      readonly writerEpoch: string;
    }
  | {
      readonly kind: "single-coordinator-preview";
    };

const serverFencedStorage = new WeakMap<Storage, Extract<Drive9StorageProfile, { kind: "server-fenced" }>>();

export function storageProfile(storage: Storage): Drive9StorageProfile {
  return serverFencedStorage.get(storage) ?? { kind: "single-coordinator-preview" };
}

export function requireServerFencedStorage(
  storage: Storage,
): Extract<Drive9StorageProfile, { kind: "server-fenced" }> {
  const profile = storageProfile(storage);
  if (profile.kind !== "server-fenced") {
    throw new Drive9ProtocolError(
      "stable_storage_required",
      "stable Drive9 publication requires storage-enforced writer epochs",
    );
  }
  return profile;
}

export function markServerFencedStorage(storage: Storage, writerEpoch: string): void {
  if (typeof writerEpoch !== "string" || writerEpoch.length === 0) {
    throw new Drive9ProtocolError("invalid_protocol_record", "writer epoch must be a non-empty string");
  }
  serverFencedStorage.set(storage, {
    kind: "server-fenced",
    protocol: "drive9.writer-epoch/v1",
    writerEpoch,
  });
}
