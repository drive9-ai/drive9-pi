import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { Drive9DurableFileSystem, } from "../drive9-durable-file-system.js";
import { Drive9ClientLease, wrapStorageWithClientLease, } from "./client-lease.js";
/**
 * Opens Pi's portable JSONL storage on a Drive9 namespace.
 *
 * This is deliberately a single-coordinator preview. Drive9 file operations
 * do not carry a server-enforced writer epoch, so this adapter cannot reject a
 * delayed stale writer after lease expiry or process takeover. Callers must
 * either keep the state root externally exclusive for the entire storage
 * lifetime or explicitly select the cooperative CAS-lease preview. The lease
 * checks ownership before and after each Pi commit and poisons the adapter when
 * the post-commit check fails, but it cannot roll back an in-flight JSONL
 * commit or make its multiple file mutations atomic.
 */
export async function openDrive9SingleCoordinatorStorage(options, context) {
    const coordination = options.coordination;
    if (coordination !== "externally-exclusive" &&
        (typeof coordination !== "object" ||
            coordination === null ||
            coordination.kind !== "drive9-cas-lease-preview")) {
        throw new TypeError("coordination must be externally-exclusive or drive9-cas-lease-preview");
    }
    const fileSystem = new Drive9DurableFileSystem({
        client: options.client,
        root: options.stateRoot,
        cwd: options.stateRoot,
        ...(options.id === undefined ? {} : { id: options.id }),
    });
    const root = await fileSystem.fileInfo(".", context);
    if (!root.ok)
        throw root.error;
    if (root.value.kind !== "directory")
        throw new TypeError("stateRoot must be a Drive9 directory");
    if (coordination === "externally-exclusive") {
        return await JsonlStorage.open(".", fileSystem, context, { fsync: true });
    }
    const lease = await Drive9ClientLease.acquire(options.client, fileSystem.root, coordination);
    let inner;
    try {
        await lease.ensureHeld();
        inner = await JsonlStorage.open(".", fileSystem, context, { fsync: true });
        await lease.ensureHeld();
        return wrapStorageWithClientLease(inner, lease);
    }
    catch (error) {
        let closeError;
        try {
            await inner?.close(context);
        }
        catch (value) {
            closeError = value;
        }
        finally {
            await lease.close();
        }
        if (closeError !== undefined) {
            throw new AggregateError([error, closeError], "storage open and cleanup both failed");
        }
        throw error;
    }
}
//# sourceMappingURL=jsonl-preview.js.map