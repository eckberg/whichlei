// How long a cached answer may be reused. GLEIF publishes a golden copy about once a day, but
// the hour is not measured, so a record is kept until a day and an hour after the golden copy
// it came from: the next publish, plus an hour of slack.

export type CacheOutcome = "found" | "not-found" | "failure";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;

export const MIN_RECORD_TTL = 5 * MINUTE;
export const MAX_RECORD_TTL = DAY;
/** Used when the record does not say which golden copy it came from. */
export const UNDATED_RECORD_TTL = HOUR;
export const NOT_FOUND_TTL = HOUR;

/** Seconds to keep a record that came from the golden copy published at `goldenCopyDate`. */
export function recordTtl(goldenCopyDate: string | null, now: Date): number {
  const published = goldenCopyDate === null ? Number.NaN : Date.parse(goldenCopyDate);
  if (Number.isNaN(published)) return UNDATED_RECORD_TTL;
  const seconds = Math.ceil((published + DAY * 1000 + HOUR * 1000 - now.getTime()) / 1000);
  return Math.min(MAX_RECORD_TTL, Math.max(MIN_RECORD_TTL, seconds));
}

/** Seconds to keep an answer in the cache. 0 means never: failures are not cached. */
export function cacheTtl(
  outcome: CacheOutcome,
  now: Date,
  goldenCopyDate: string | null = null,
): number {
  switch (outcome) {
    case "found":
      return recordTtl(goldenCopyDate, now);
    case "not-found":
      return NOT_FOUND_TTL;
    case "failure":
      return 0;
  }
}
