import { describe, expect, it } from "vitest";
import { cacheTtl, secondsUntilRefresh } from "./ttl.ts";

const at = (iso: string) => new Date(iso);

describe("secondsUntilRefresh", () => {
  it("counts to 09:00 UTC the same day when it is earlier", () => {
    expect(secondsUntilRefresh(at("2026-09-30T00:00:00Z"))).toBe(9 * 3600);
    expect(secondsUntilRefresh(at("2026-09-30T08:59:00Z"))).toBe(60);
  });

  it("counts to 09:00 UTC the next day when that has passed", () => {
    expect(secondsUntilRefresh(at("2026-09-30T10:00:00Z"))).toBe(23 * 3600);
    expect(secondsUntilRefresh(at("2026-09-30T23:59:59Z"))).toBe(9 * 3600 + 1);
  });

  it("waits a full day at exactly 09:00", () => {
    expect(secondsUntilRefresh(at("2026-09-30T09:00:00Z"))).toBe(24 * 3600);
  });

  it("rounds a part second up and is never zero", () => {
    expect(secondsUntilRefresh(at("2026-09-30T08:59:59.400Z"))).toBe(1);
    expect(secondsUntilRefresh(at("2026-09-30T08:59:59.999Z"))).toBe(1);
  });

  it("crosses month and year ends", () => {
    expect(secondsUntilRefresh(at("2026-12-31T12:00:00Z"))).toBe(21 * 3600);
    expect(secondsUntilRefresh(at("2026-02-28T09:30:00Z"))).toBe(23.5 * 3600);
  });

  it("never exceeds 24 hours", () => {
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const now = new Date(Date.UTC(2026, 8, 30, 0, minute));
      const seconds = secondsUntilRefresh(now);
      expect(seconds).toBeGreaterThanOrEqual(1);
      expect(seconds).toBeLessThanOrEqual(86400);
    }
  });
});

describe("cacheTtl", () => {
  const now = at("2026-09-30T10:00:00Z");
  it("keeps a record until the next refresh", () => {
    expect(cacheTtl("found", now)).toBe(23 * 3600);
  });
  it("keeps an unknown LEI for an hour", () => {
    expect(cacheTtl("not-found", now)).toBe(3600);
  });
  it("never keeps a failure", () => {
    expect(cacheTtl("failure", now)).toBe(0);
  });
});
