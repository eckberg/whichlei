import { describe, expect, it } from "vitest";
import { cacheTtl, recordTtl } from "./ttl.ts";

const at = (iso: string) => new Date(iso);
const GOLDEN = "2026-09-30T08:00:00Z";
const HOUR = 3600;

describe("recordTtl", () => {
  it("expires 25 hours after the golden copy", () => {
    // 10:00 is two hours after the golden copy, so 23 hours remain.
    expect(recordTtl(GOLDEN, at("2026-09-30T10:00:00Z"))).toBe(23 * HOUR);
    expect(recordTtl(GOLDEN, at("2026-10-01T08:00:00Z"))).toBe(HOUR);
  });

  it("is at most 24 hours, even for a golden copy in the future", () => {
    expect(recordTtl(GOLDEN, at("2026-09-30T08:00:00Z"))).toBe(24 * HOUR);
    expect(recordTtl(GOLDEN, at("2026-09-30T00:00:00Z"))).toBe(24 * HOUR);
    expect(recordTtl(GOLDEN, at("2026-09-29T00:00:00Z"))).toBe(24 * HOUR);
  });

  it("is at least 5 minutes, even for a golden copy that is stale or past its expiry", () => {
    expect(recordTtl(GOLDEN, at("2026-10-01T09:00:00Z"))).toBe(300);
    expect(recordTtl(GOLDEN, at("2026-10-01T08:59:00Z"))).toBe(300);
    expect(recordTtl(GOLDEN, at("2026-10-05T00:00:00Z"))).toBe(300);
  });

  it("changes at the 5 minute edge", () => {
    expect(recordTtl(GOLDEN, at("2026-10-01T08:55:00Z"))).toBe(300);
    expect(recordTtl(GOLDEN, at("2026-10-01T08:54:00Z"))).toBe(360);
  });

  it("rounds a part second up", () => {
    expect(recordTtl(GOLDEN, at("2026-09-30T10:00:00.400Z"))).toBe(23 * HOUR);
  });

  it("falls back to an hour when the date is missing or not a date", () => {
    expect(recordTtl(null, at("2026-09-30T10:00:00Z"))).toBe(HOUR);
    expect(recordTtl("", at("2026-09-30T10:00:00Z"))).toBe(HOUR);
    expect(recordTtl("yesterday-ish", at("2026-09-30T10:00:00Z"))).toBe(HOUR);
  });
});

describe("cacheTtl", () => {
  const now = at("2026-09-30T10:00:00Z");
  it("keeps a record as recordTtl says", () => {
    expect(cacheTtl("found", now, GOLDEN)).toBe(23 * HOUR);
    expect(cacheTtl("found", now)).toBe(HOUR);
  });
  it("keeps an unknown LEI for an hour", () => {
    expect(cacheTtl("not-found", now, GOLDEN)).toBe(HOUR);
  });
  it("never keeps a failure", () => {
    expect(cacheTtl("failure", now, GOLDEN)).toBe(0);
  });
});
