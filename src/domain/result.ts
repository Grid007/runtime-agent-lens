/**
 * Tagged error algebra for tool results. Agents receive a machine-readable
 * code, a message, optional details and a remediation hint instead of a
 * stack trace (pattern borrowed from REA's Result type).
 */
export type DebugErrorCode =
  | "no_session"
  | "not_stopped"
  | "not_running"
  | "not_found"
  | "invalid_input"
  | "dap_error"
  | "timeout"
  | "unsupported"
  | "host_error"
  | "forbidden";

export interface DebugError {
  readonly code: DebugErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly remediation?: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DebugError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = <T = never>(
  code: DebugErrorCode,
  message: string,
  extra: { details?: Record<string, unknown>; remediation?: string } = {},
): Result<T> => ({
  ok: false,
  error: {
    code,
    message,
    ...(extra.details === undefined ? {} : { details: extra.details }),
    ...(extra.remediation === undefined ? {} : { remediation: extra.remediation }),
  },
});

export const errorMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
};

/** Project an unknown thrown value into a DebugError-shaped failure. */
export const failFromUnknown = <T = never>(
  code: DebugErrorCode,
  cause: unknown,
  details?: Record<string, unknown>,
  remediation?: string,
): Result<T> => fail<T>(code, errorMessage(cause), { details, remediation });
