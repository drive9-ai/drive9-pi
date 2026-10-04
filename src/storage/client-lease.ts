import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { Storage, StorageWrite } from "@earendil-works/pi-durable";
import { Drive9ProtocolError, protocolCause } from "../core/errors.js";
import { normalizeDrive9AbsoluteRoot } from "../drive9-path.js";
import type {
  Drive9DurableFileSystemClient,
  Drive9Stat,
} from "../drive9-durable-file-system.js";

const LEASE_VERSION = 1;
const STABLE_READ_ATTEMPTS = 8;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });

interface LeaseRecord {
  readonly version: typeof LEASE_VERSION;
  readonly stateRoot: string;
  readonly holderId: string;
  readonly leaseId: string;
  readonly epoch: number;
  readonly expiresAtMs: number;
}

interface LeaseSnapshot {
  readonly record: LeaseRecord;
  readonly revision: number;
}

export interface Drive9ClientLeasePreviewOptions {
  readonly kind: "drive9-cas-lease-preview";
  /** Unique diagnostic identity for this coordinator process. */
  readonly holderId: string;
  /** Absolute Drive9 path outside stateRoot used for the cooperative lease record. */
  readonly leasePath: string;
  /** Client-wall-clock lease lifetime. Must be a positive integer. */
  readonly leaseDurationMs: number;
  /** Renewal cadence. Must be positive and less than leaseDurationMs. */
  readonly renewIntervalMs: number;
}

type LeaseClient = Drive9DurableFileSystemClient & {
  writeWithRevision(
    path: string,
    data: Uint8Array,
    options: { expectedRevision: number },
  ): Promise<number>;
};

function statusCode(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("statusCode" in value && typeof value.statusCode === "number") return value.statusCode;
  if ("status" in value && typeof value.status === "number") return value.status;
  return undefined;
}

function isMissing(value: unknown): boolean {
  return statusCode(value) === 404 || protocolCause(value).message.toLowerCase().includes("not found");
}

function isConflict(value: unknown): boolean {
  const message = protocolCause(value).message.toLowerCase();
  return statusCode(value) === 409 || statusCode(value) === 412 || message.includes("revision conflict");
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function protocolPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Drive9ProtocolError("invalid_protocol_record", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Drive9ProtocolError("invalid_protocol_record", `${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Drive9ProtocolError("invalid_protocol_record", `${label} must be a non-empty string`);
  }
  return value;
}

function leaseDeadline(now: number, leaseDurationMs: number): number {
  const expiresAtMs = now + leaseDurationMs;
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new TypeError("leaseDurationMs is too large");
  }
  return expiresAtMs;
}

function parseLeaseRecord(bytes: Uint8Array, expectedStateRoot: string): LeaseRecord {
  let value: unknown;
  try {
    value = JSON.parse(DECODER.decode(bytes));
  } catch (error) {
    throw new Drive9ProtocolError("invalid_protocol_record", "Drive9 session lease is not valid JSON", protocolCause(error));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Drive9ProtocolError("invalid_protocol_record", "Drive9 session lease must be an object");
  }
  const object = value as Record<string, unknown>;
  if (object.version !== LEASE_VERSION) {
    throw new Drive9ProtocolError("invalid_protocol_record", "unsupported Drive9 session lease version");
  }
  const stateRoot = nonEmptyString(object.stateRoot, "lease stateRoot");
  if (stateRoot !== expectedStateRoot) {
    throw new Drive9ProtocolError("invalid_protocol_record", "Drive9 session lease stateRoot does not match");
  }
  return {
    version: LEASE_VERSION,
    stateRoot,
    holderId: nonEmptyString(object.holderId, "lease holderId"),
    leaseId: nonEmptyString(object.leaseId, "lease leaseId"),
    epoch: protocolPositiveInteger(object.epoch, "lease epoch"),
    expiresAtMs: nonNegativeInteger(object.expiresAtMs, "lease expiresAtMs"),
  };
}

function encodeLeaseRecord(record: LeaseRecord): Uint8Array {
  return ENCODER.encode(`${JSON.stringify(record)}\n`);
}

function sameLease(left: LeaseRecord, right: LeaseRecord): boolean {
  return (
    left.version === right.version &&
    left.stateRoot === right.stateRoot &&
    left.holderId === right.holderId &&
    left.leaseId === right.leaseId &&
    left.epoch === right.epoch
  );
}

function leaseLost(message: string): Drive9ProtocolError {
  return new Drive9ProtocolError("session_lease_lost", message);
}

function leaseUnavailable(message: string, cause: unknown): Drive9ProtocolError {
  return new Drive9ProtocolError("session_lease_unavailable", message, protocolCause(cause));
}

function validatedClient(client: Drive9DurableFileSystemClient): LeaseClient {
  if (typeof client.writeWithRevision !== "function") {
    throw new TypeError("drive9-cas-lease-preview requires client.writeWithRevision()");
  }
  return client as LeaseClient;
}

export class Drive9ClientLease {
  private record: LeaseRecord;
  private renewalTail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lost: Drive9ProtocolError | undefined;
  private closing = false;

  private constructor(
    private readonly client: LeaseClient,
    private readonly leasePath: string,
    private readonly leaseDurationMs: number,
    private readonly renewIntervalMs: number,
    record: LeaseRecord,
  ) {
    this.record = record;
    this.scheduleRenewal();
  }

  static async acquire(
    clientValue: Drive9DurableFileSystemClient,
    stateRootValue: string,
    options: Drive9ClientLeasePreviewOptions,
  ): Promise<Drive9ClientLease> {
    const client = validatedClient(clientValue);
    const stateRoot = normalizeDrive9AbsoluteRoot(stateRootValue, "stateRoot", (message) => new TypeError(message));
    const leasePath = normalizeDrive9AbsoluteRoot(options.leasePath, "leasePath", (message) => new TypeError(message));
    if (leasePath === stateRoot || leasePath.startsWith(`${stateRoot}/`)) {
      throw new TypeError("leasePath must be outside stateRoot");
    }
    if (typeof options.holderId !== "string" || options.holderId.length === 0) {
      throw new TypeError("holderId must be a non-empty string");
    }
    const leaseDurationMs = positiveInteger(options.leaseDurationMs, "leaseDurationMs");
    const renewIntervalMs = positiveInteger(options.renewIntervalMs, "renewIntervalMs");
    if (renewIntervalMs >= leaseDurationMs) {
      throw new TypeError("renewIntervalMs must be less than leaseDurationMs");
    }

    const leaseId = randomUUID();
    for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
      const current = await readLeaseSnapshot(client, leasePath, stateRoot);
      const now = Date.now();
      if (current !== undefined && current.record.expiresAtMs > now) {
        throw new Drive9ProtocolError(
          "session_already_open",
          `Drive9 session is already held by ${current.record.holderId}`,
        );
      }
      const record: LeaseRecord = {
        version: LEASE_VERSION,
        stateRoot,
        holderId: options.holderId,
        leaseId,
        epoch:
          current === undefined
            ? 1
            : protocolPositiveInteger(current.record.epoch + 1, "next lease epoch"),
        expiresAtMs: leaseDeadline(now, leaseDurationMs),
      };
      try {
        await client.writeWithRevision(leasePath, encodeLeaseRecord(record), {
          expectedRevision: current?.revision ?? 0,
        });
        if (record.expiresAtMs <= Date.now()) {
          throw leaseLost("Drive9 session lease expired during acquisition");
        }
        return new Drive9ClientLease(client, leasePath, leaseDurationMs, renewIntervalMs, record);
      } catch (error) {
        if (error instanceof Drive9ProtocolError && error.code === "session_lease_lost") throw error;
        if (isConflict(error)) continue;
        const reconciled = await reconcileLeaseWrite(client, leasePath, stateRoot, record);
        if (reconciled !== undefined && reconciled.record.expiresAtMs > Date.now()) {
          return new Drive9ClientLease(
            client,
            leasePath,
            leaseDurationMs,
            renewIntervalMs,
            reconciled.record,
          );
        }
        throw leaseUnavailable("failed to acquire Drive9 session lease", error);
      }
    }
    throw leaseUnavailable("Drive9 session lease changed too many times during acquisition", new Error("conflict"));
  }

  async ensureHeld(): Promise<void> {
    if (this.lost !== undefined) throw this.lost;
    if (this.closing) throw leaseLost("Drive9 session lease is closing");
    this.clearTimer();
    const renewal = this.renewalTail.then(async () => await this.renewOnce());
    this.renewalTail = renewal.catch(() => undefined);
    try {
      await renewal;
    } finally {
      this.scheduleRenewal();
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.clearTimer();
    await this.renewalTail;
    try {
      const current = await readLeaseSnapshot(this.client, this.leasePath, this.record.stateRoot);
      if (current === undefined || !sameLease(current.record, this.record)) return;
      const released: LeaseRecord = { ...current.record, expiresAtMs: 0 };
      await this.client.writeWithRevision(this.leasePath, encodeLeaseRecord(released), {
        expectedRevision: current.revision,
      });
    } catch {
      // Best-effort release must never delete or overwrite a successor lease.
    }
  }

  private async renewOnce(): Promise<void> {
    if (this.lost !== undefined) throw this.lost;
    let current: LeaseSnapshot | undefined;
    try {
      current = await readLeaseSnapshot(this.client, this.leasePath, this.record.stateRoot);
    } catch (error) {
      if (Date.now() >= this.record.expiresAtMs) {
        throw this.markLost("Drive9 session lease expired while unavailable");
      }
      throw leaseUnavailable("failed to verify Drive9 session lease", error);
    }
    const now = Date.now();
    if (current === undefined || !sameLease(current.record, this.record)) {
      throw this.markLost("Drive9 session lease is no longer owned by this coordinator");
    }
    if (current.record.expiresAtMs <= now) throw this.markLost("Drive9 session lease expired");

    const renewed: LeaseRecord = {
      ...current.record,
      expiresAtMs: leaseDeadline(now, this.leaseDurationMs),
    };
    try {
      await this.client.writeWithRevision(this.leasePath, encodeLeaseRecord(renewed), {
        expectedRevision: current.revision,
      });
      if (renewed.expiresAtMs <= Date.now()) {
        throw this.markLost("Drive9 session lease expired during renewal");
      }
      this.record = renewed;
    } catch (error) {
      if (error instanceof Drive9ProtocolError && error.code === "session_lease_lost") throw error;
      if (isConflict(error)) {
        throw this.markLost("Drive9 session lease changed during renewal");
      }
      const reconciled = await reconcileLeaseWrite(
        this.client,
        this.leasePath,
        this.record.stateRoot,
        renewed,
      );
      if (reconciled === undefined || reconciled.record.expiresAtMs <= Date.now()) {
        if (Date.now() >= this.record.expiresAtMs) {
          throw this.markLost("Drive9 session lease renewal outcome is unknown after expiry");
        }
        throw leaseUnavailable("failed to renew Drive9 session lease", error);
      }
      this.record = reconciled.record;
    }
  }

  private markLost(message: string): Drive9ProtocolError {
    this.lost ??= leaseLost(message);
    this.clearTimer();
    return this.lost;
  }

  private scheduleRenewal(): void {
    if (this.closing || this.lost !== undefined || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.ensureHeld().catch(() => undefined);
    }, this.renewIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

async function readLeaseSnapshot(
  client: LeaseClient,
  leasePath: string,
  stateRoot: string,
): Promise<LeaseSnapshot | undefined> {
  for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
    let before: Drive9Stat;
    try {
      before = await client.stat(leasePath);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (before.isDir) {
      throw new Drive9ProtocolError("invalid_protocol_record", "Drive9 session lease path is a directory");
    }
    let bytes: Uint8Array;
    try {
      bytes = await client.read(leasePath);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    let after: Drive9Stat;
    try {
      after = await client.stat(leasePath);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (before.revision !== after.revision) continue;
    return { record: parseLeaseRecord(bytes, stateRoot), revision: after.revision };
  }
  throw leaseUnavailable("Drive9 session lease did not stabilize while reading", new Error("revision changed"));
}

async function reconcileLeaseWrite(
  client: LeaseClient,
  leasePath: string,
  stateRoot: string,
  expected: LeaseRecord,
): Promise<LeaseSnapshot | undefined> {
  try {
    const current = await readLeaseSnapshot(client, leasePath, stateRoot);
    if (current !== undefined && sameLease(current.record, expected) && current.record.expiresAtMs === expected.expiresAtMs) {
      return current;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function wrapStorageWithClientLease(inner: Storage, lease: Drive9ClientLease): Storage {
  let poisoned: Drive9ProtocolError | undefined;
  return {
    async commit(writes: readonly StorageWrite[], context: Context) {
      if (poisoned !== undefined) throw poisoned;
      await lease.ensureHeld();
      let sequence: Awaited<ReturnType<Storage["commit"]>> | undefined;
      let commitError: unknown;
      try {
        sequence = await inner.commit(writes, context);
      } catch (error) {
        commitError = error;
      }
      let leaseError: unknown;
      try {
        await lease.ensureHeld();
      } catch (error) {
        leaseError = error;
        poisoned = new Drive9ProtocolError(
          "session_poisoned",
          "Drive9 session lease could not be verified after a storage commit; reopen and recover",
          protocolCause(error),
        );
      }
      if (commitError !== undefined && leaseError !== undefined) {
        throw new AggregateError([commitError, leaseError], "storage commit and post-commit lease verification failed");
      }
      if (commitError !== undefined) throw commitError;
      if (leaseError !== undefined) throw poisoned;
      return sequence as Awaited<ReturnType<Storage["commit"]>>;
    },
    mintId: inner.mintId.bind(inner),
    conversation: inner.conversation.bind(inner),
    scanConversations: inner.scanConversations.bind(inner),
    entry: inner.entry.bind(inner),
    findLatestHeadMarker: inner.findLatestHeadMarker.bind(inner),
    scanEntries: inner.scanEntries.bind(inner),
    task: inner.task.bind(inner),
    scanTasks: inner.scanTasks.bind(inner),
    submission: inner.submission.bind(inner),
    scanSubmissions: inner.scanSubmissions.bind(inner),
    submissionByRequest: inner.submissionByRequest.bind(inner),
    findDocument: inner.findDocument.bind(inner),
    document: inner.document.bind(inner),
    scanDocuments: inner.scanDocuments.bind(inner),
    async close(context: Context): Promise<void> {
      try {
        await inner.close(context);
      } finally {
        await lease.close();
      }
    },
  };
}
