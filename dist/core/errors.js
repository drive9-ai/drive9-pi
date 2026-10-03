export class Drive9ProtocolError extends Error {
    code;
    constructor(code, message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "Drive9ProtocolError";
        this.code = code;
    }
}
export function protocolCause(value) {
    return value instanceof Error ? value : new Error(String(value));
}
//# sourceMappingURL=errors.js.map