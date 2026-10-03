export interface RuntimeIsolationProbeClient {
    writeWithRevision(path: string, data: Uint8Array, options: {
        expectedRevision: number;
    }): Promise<number>;
    read(path: string): Promise<Uint8Array>;
    delete(path: string): Promise<void>;
    mkdir(path: string, mode?: number): Promise<void>;
}
export interface RuntimeIsolationOptions {
    workspaceRemoteRoot: string;
    stateRemoteRoot: string;
    evidenceRemoteRoot: string;
    workspaceClient: RuntimeIsolationProbeClient;
    stateClient: RuntimeIsolationProbeClient;
    evidenceClient: RuntimeIsolationProbeClient;
    workspaceEvidenceRead: "allow" | "deny";
}
export interface RuntimeIsolationReceipt {
    rootsDisjoint: true;
    workspaceCreateReadReplaceDelete: true;
    stateCreateReadReplaceDelete: true;
    evidenceCreateReadReplaceDelete: true;
    workspaceStateReadDenied: true;
    workspaceStateWriteDenied: true;
    workspaceStateDeleteDenied: true;
    workspaceEvidenceRead: "allowed" | "denied";
    workspaceEvidenceWriteDenied: true;
    workspaceEvidenceDeleteDenied: true;
    stateWorkspaceWriteDenied: true;
    stateWorkspaceDeleteDenied: true;
    evidenceStateWriteDenied: true;
    evidenceStateDeleteDenied: true;
    verifiedAt: string;
}
export declare function verifyRuntimeIsolation(options: RuntimeIsolationOptions): Promise<RuntimeIsolationReceipt>;
//# sourceMappingURL=runtime-isolation.d.ts.map