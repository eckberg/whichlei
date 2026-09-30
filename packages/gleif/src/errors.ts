// What went wrong with a request. The client never retries: the caller decides, using `kind`.

export type GleifErrorKind =
  /** 404: no such LEI. Lookups by ISIN, BIC or register number return no hits instead. */
  | "not-found"
  /** 429: over GLEIF's per-IP limit (about 60 requests a minute). See `retryAfter`. */
  | "rate-limited"
  /** Anything else: a network failure, another status, or a body that is not what we expect. */
  | "failed";

export class GleifError extends Error {
  override readonly name = "GleifError";
  readonly kind: GleifErrorKind;
  /** HTTP status, or null when no response arrived or it could not be read. */
  readonly status: number | null;
  /**
   * Seconds to wait, from the Retry-After header of a 429. Null when absent. Browsers hide
   * the header from cross-origin pages (GLEIF does not expose it), so expect null there.
   */
  readonly retryAfter: number | null;

  constructor(
    kind: GleifErrorKind,
    message: string,
    details: { status?: number; retryAfter?: number | null; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.kind = kind;
    this.status = details.status ?? null;
    this.retryAfter = details.retryAfter ?? null;
  }
}

/** Retry-After is either a number of seconds or an HTTP date. Null if neither. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim() === "") return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}
