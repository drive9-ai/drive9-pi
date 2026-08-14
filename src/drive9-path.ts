import { posix } from "node:path";

type ErrorFactory = (message: string) => Error;

const TRANSPORT_UNSAFE = /[%?#\\\u0000-\u001f\u007f]/u;

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Normalize text before it is passed to the Drive9 SDK as a path.
 *
 * drive9@0.1.4 concatenates paths into request URLs, so URL delimiters,
 * percent escapes, controls, and backslashes are not safely addressable.
 * Drive9's namespace is NFC-normalized; doing the same here keeps Pi's
 * addressed and canonical paths aligned with the remote object identity.
 */
export function normalizeDrive9PathText(
  value: unknown,
  label: string,
  allowEmpty: boolean,
  createError: ErrorFactory,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw createError(`${label} must be ${allowEmpty ? "" : "a non-empty "}string`);
  }
  if (!isWellFormedUnicode(value)) throw createError(`${label} must contain well-formed Unicode`);
  const normalized = value.normalize("NFC");
  if (TRANSPORT_UNSAFE.test(normalized)) {
    throw createError(`${label} contains characters that cannot be safely addressed by the Drive9 SDK`);
  }
  return normalized;
}

export function normalizeDrive9AbsoluteRoot(
  value: unknown,
  label: string,
  createError: ErrorFactory,
): string {
  const transportSafe = normalizeDrive9PathText(value, label, false, createError);
  if (!posix.isAbsolute(transportSafe)) {
    throw createError(`${label} must be an absolute POSIX path`);
  }
  const normalized = posix.normalize(transportSafe);
  if (normalized === "/") throw createError(`${label} cannot be the tenant root`);
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}
