// How long a cached answer may be reused. GLEIF publishes its golden copy about 08:00 UTC, so
// a record stays cached until 09:00 UTC, the next time that comes around.

export type CacheOutcome = "found" | "not-found" | "failure";

const HOUR = 3600;
const DAY = 24 * HOUR;
const REFRESH_HOUR_UTC = 9;

/** Seconds from `now` until the next 09:00 UTC. Always 1 to 86,400. */
export function secondsUntilRefresh(now: Date): number {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    REFRESH_HOUR_UTC,
  );
  const next = today > now.getTime() ? today : today + DAY * 1000;
  return Math.min(DAY, Math.max(1, Math.ceil((next - now.getTime()) / 1000)));
}

/** Seconds to keep an answer in the cache. 0 means never: failures are not cached. */
export function cacheTtl(outcome: CacheOutcome, now: Date): number {
  switch (outcome) {
    case "found":
      return secondsUntilRefresh(now);
    case "not-found":
      return HOUR;
    case "failure":
      return 0;
  }
}
