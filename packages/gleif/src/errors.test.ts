import { describe, expect, test } from "vitest";
import { GleifError, parseRetryAfter } from "./errors.ts";

describe("parseRetryAfter", () => {
  test("reads seconds", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter(" 0 ")).toBe(0);
  });

  test("reads an HTTP date as seconds from now", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(parseRetryAfter("Wed, 30 Sep 2026 12:01:30 GMT", now)).toBe(90);
    expect(parseRetryAfter("Wed, 30 Sep 2026 11:00:00 GMT", now)).toBe(0);
  });

  test("returns null when there is nothing usable", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("GleifError", () => {
  test("carries its kind and defaults the rest to null", () => {
    const error = new GleifError("failed", "boom");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GleifError");
    expect(error).toMatchObject({ kind: "failed", status: null, retryAfter: null });
    expect(error.cause).toBeUndefined();
  });
});
