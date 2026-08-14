export class ResultStoreError extends Error {
    code;
    constructor(code, message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "ResultStoreError";
        this.code = code;
    }
}
//# sourceMappingURL=tool-result-types.js.map