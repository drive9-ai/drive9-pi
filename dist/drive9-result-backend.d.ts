import { PersistentToolResultStore } from "./tool-result-store.js";
import { type PersistentToolResultStoreOptions, type ResultStoreBackend, type ResultStoreObject } from "./tool-result-types.js";
export interface Drive9ResultClient {
    writeWithRevision(path: string, data: Uint8Array, options: {
        expectedRevision: number;
    }): Promise<number>;
    read(path: string): Promise<Uint8Array>;
    stat(path: string): Promise<{
        size: number;
        isDir: boolean;
        revision: number;
    }>;
    mkdir(path: string, mode?: number): Promise<void>;
}
export interface Drive9ResultStoreBackendOptions {
    client: Drive9ResultClient;
    evidenceRoot: string;
    stableReadAttempts?: number;
}
export interface CreateDrive9ResultStoreOptions extends Omit<PersistentToolResultStoreOptions, "backend">, Drive9ResultStoreBackendOptions {
}
export declare class Drive9ResultStoreBackend implements ResultStoreBackend {
    private readonly client;
    private readonly evidenceRoot;
    private readonly stableReadAttempts;
    constructor(options: Drive9ResultStoreBackendOptions);
    create(path: string, data: Uint8Array): Promise<{
        revision: number;
    }>;
    read(path: string): Promise<ResultStoreObject>;
    replace(path: string, data: Uint8Array, expectedRevision: number): Promise<{
        revision: number;
    }>;
    private resolve;
    private ensureParentDirectories;
}
export declare function createDrive9ResultStore(options: CreateDrive9ResultStoreOptions): PersistentToolResultStore;
//# sourceMappingURL=drive9-result-backend.d.ts.map