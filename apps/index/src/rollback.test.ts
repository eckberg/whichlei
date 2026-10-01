import { describe, expect, test } from "vitest";
import { pickRollbackTarget, type WorkerVersion } from "./rollback.ts";

const v = (id: string, message: string | undefined, created: string): WorkerVersion => ({
  id,
  metadata: { created_on: created },
  annotations: message === undefined ? {} : { "workers/message": message },
});

const A = "20260915-aaaaaaaa";
const B = "20260916-bbbbbbbb";
const C = "20260917-cccccccc";
// As `wrangler versions list --json` returns them: oldest first.
const versions = [
  v("v-a", A, "2026-09-15T02:50:00Z"),
  v("v-b", B, "2026-09-16T02:50:00Z"),
  v("v-c", C, "2026-09-17T02:50:00Z"),
];

describe("pickRollbackTarget without a version id", () => {
  test("the newest build older than the live one", () => {
    expect(pickRollbackTarget(versions, C)).toEqual({ id: "v-b", build: B });
  });

  test("after a rollback to B, the next one goes to A: the live build decides, not the last deploy", () => {
    expect(pickRollbackTarget(versions, B)).toEqual({ id: "v-a", build: A });
  });

  test("nothing older: an error", () => {
    expect(pickRollbackTarget(versions, A)).toEqual({
      error: expect.stringContaining("older than 20260915-aaaaaaaa"),
    });
  });

  test("builds compare by date, then by the whole id", () => {
    const same = [
      v("v-1", "20260917-11111111", "2026-09-17T01:00:00Z"),
      v("v-2", "20260917-99999999", "2026-09-17T02:00:00Z"),
      v("v-3", "20260918-00000000", "2026-09-18T02:00:00Z"),
    ];
    expect(pickRollbackTarget(same, "20260918-00000000")).toEqual({
      id: "v-2",
      build: "20260917-99999999",
    });
    expect(pickRollbackTarget(same, "20260917-99999999")).toEqual({
      id: "v-1",
      build: "20260917-11111111",
    });
  });

  test("the newest of several versions of the same build", () => {
    const again = [
      v("old", B, "2026-09-16T02:50:00Z"),
      v("new", B, "2026-09-16T14:50:00Z"),
      v("c", C, "2026-09-17T02:50:00Z"),
    ];
    expect(pickRollbackTarget(again, C)).toEqual({ id: "new", build: B });
  });

  test("versions with another message, or none, are ignored; so are newer builds", () => {
    const mixed = [
      v("manual", "a hotfix", "2026-09-16T05:00:00Z"),
      v("none", undefined, "2026-09-16T06:00:00Z"),
      v("b", B, "2026-09-16T02:50:00Z"),
      v("c", C, "2026-09-17T02:50:00Z"),
      v("d", "20260918-dddddddd", "2026-09-18T02:50:00Z"),
    ];
    expect(pickRollbackTarget(mixed, C)).toEqual({ id: "b", build: B });
  });

  test("an odd live build is an error", () => {
    expect(pickRollbackTarget(versions, "")).toEqual({
      error: expect.stringContaining("not a build id"),
    });
  });
});

describe("pickRollbackTarget with a version id", () => {
  test("that version, with the build its message names", () => {
    expect(pickRollbackTarget(versions, C, "v-a")).toEqual({ id: "v-a", build: A });
  });

  test("a version that is not in the list, has no build id, or serves the live build is refused", () => {
    expect(pickRollbackTarget(versions, C, "nope")).toEqual({
      error: expect.stringContaining("not among"),
    });
    expect(pickRollbackTarget([v("x", "hotfix", "2026-09-16T00:00:00Z")], C, "x")).toEqual({
      error: expect.stringContaining("no build id"),
    });
    expect(pickRollbackTarget(versions, C, "v-c")).toEqual({
      error: expect.stringContaining("live already"),
    });
  });
});
