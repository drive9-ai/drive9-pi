type ErrorFactory = (message: string) => Error;
/**
 * Normalize text before it is passed to the Drive9 SDK as a path.
 *
 * drive9@0.1.4 concatenates paths into request URLs, so URL delimiters,
 * percent escapes, controls, and backslashes are not safely addressable.
 * Drive9's namespace is NFC-normalized; doing the same here keeps Pi's
 * addressed and canonical paths aligned with the remote object identity.
 */
export declare function normalizeDrive9PathText(value: unknown, label: string, allowEmpty: boolean, createError: ErrorFactory): string;
export declare function normalizeDrive9AbsoluteRoot(value: unknown, label: string, createError: ErrorFactory): string;
export {};
//# sourceMappingURL=drive9-path.d.ts.map