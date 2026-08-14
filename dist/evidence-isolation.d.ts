export interface EvidenceProbeClient {
    writeWithRevision(path: string, data: Uint8Array, options: {
        expectedRevision: number;
    }): Promise<number>;
    read(path: string): Promise<Uint8Array>;
    delete(path: string): Promise<void>;
    mkdir(path: string, mode?: number): Promise<void>;
}
export interface EvidenceIsolationOptions {
    workspaceRemoteRoot: string;
    evidenceRemoteRoot: string;
    workspaceClient: EvidenceProbeClient;
    evidenceClient: EvidenceProbeClient;
}
export interface EvidenceIsolationReceipt {
    workspaceRootVerified: true;
    rootsDisjoint: true;
    evidenceCreateReadReplaceDelete: true;
    workspaceReadDenied: true;
    workspaceWriteDenied: true;
    workspaceDeleteDenied: true;
    verifiedAt: string;
}
export declare function verifyEvidenceIsolation(options: EvidenceIsolationOptions): Promise<EvidenceIsolationReceipt>;
//# sourceMappingURL=evidence-isolation.d.ts.map