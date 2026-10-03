import type { Context } from "@earendil-works/chord";
import type { Storage } from "@earendil-works/pi-durable";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import {
  Drive9DurableFileSystem,
  type Drive9DurableFileSystemClient,
} from "../drive9-durable-file-system.js";

export interface Drive9SingleCoordinatorStorageOptions {
  readonly client: Drive9DurableFileSystemClient;
  /** Existing absolute Drive9 directory reserved for one Pi session's durable state. */
  readonly stateRoot: string;
  /**
   * Required acknowledgement that another coordinator prevents concurrent or
   * automatic-takeover writers for this state root.
   */
  readonly coordination: "externally-exclusive";
  /** Stable namespace identity for equal state roots. Defaults to the filesystem namespace id. */
  readonly id?: string;
}

/**
 * Opens Pi's portable JSONL storage on a Drive9 namespace.
 *
 * This is deliberately a single-coordinator preview. Drive9 file operations
 * do not carry a server-enforced writer epoch, so this adapter cannot reject a
 * delayed stale writer after lease expiry or process takeover. The caller must
 * keep the state root externally exclusive for the entire storage lifetime.
 */
export async function openDrive9SingleCoordinatorStorage(
  options: Drive9SingleCoordinatorStorageOptions,
  context: Context,
): Promise<Storage> {
  if (options.coordination !== "externally-exclusive") {
    throw new TypeError("coordination must be externally-exclusive");
  }

  const fileSystem = new Drive9DurableFileSystem({
    client: options.client,
    root: options.stateRoot,
    cwd: options.stateRoot,
    ...(options.id === undefined ? {} : { id: options.id }),
  });
  const root = await fileSystem.fileInfo(".", context);
  if (!root.ok) throw root.error;
  if (root.value.kind !== "directory") throw new TypeError("stateRoot must be a Drive9 directory");
  return await JsonlStorage.open(".", fileSystem, context, { fsync: true });
}
