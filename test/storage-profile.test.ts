import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../src/core/errors.js";
import { markServerFencedStorage, requireServerFencedStorage, storageProfile } from "../src/storage/profile.js";

test("generic Pi storage is preview and stable construction fails closed", () => {
  const storage = new MemoryStorage();
  assert.deepEqual(storageProfile(storage), { kind: "single-coordinator-preview" });
  assert.throws(
    () => requireServerFencedStorage(storage),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "stable_storage_required",
  );
});

test("only an explicitly marked backend exposes a server-fenced profile", () => {
  const storage = new MemoryStorage();
  markServerFencedStorage(storage, "epoch-9");
  assert.deepEqual(requireServerFencedStorage(storage), {
    kind: "server-fenced",
    protocol: "drive9.writer-epoch/v1",
    writerEpoch: "epoch-9",
  });
});
