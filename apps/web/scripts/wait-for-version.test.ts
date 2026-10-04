import { describe, expect, it } from "vitest";
import { waitForVersion } from "./wait-for-version.ts";

const NEW = "6ea33c29-2bd4-465a-93c1-26cce04efee6";
const OLD = "0d1f6c2e-9a77-4b8e-8f3e-2b1c5a4e7d90";

/** A host that answers each request with the next of `answers` (the last one repeats). */
function host(answers: (string | null | Error)[]) {
  const requests: { url: string; method: string | undefined }[] = [];
  let clock = 0;
  const lines: string[] = [];
  return {
    requests,
    lines,
    options: {
      origin: "https://whichlei.test",
      version: NEW,
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, method: init.method });
        const answer = answers[Math.min(requests.length, answers.length) - 1];
        if (answer instanceof Error) throw answer;
        const headers: Record<string, string> = answer ? { "x-whichlei-version": answer } : {};
        return new Response(null, { status: 200, headers });
      },
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      log: (line: string) => lines.push(line),
    },
  };
}

describe("waitForVersion", () => {
  it("asks /robots.txt until the new version answers five times in a row", async () => {
    const h = host([OLD, OLD, NEW]);
    expect(await waitForVersion(h.options)).toBe(7);
    expect(new Set(h.requests.map((r) => `${r.method} ${r.url}`))).toEqual(
      new Set(["HEAD https://whichlei.test/robots.txt"]),
    );
    expect(h.lines.at(-1)).toBe(
      `https://whichlei.test serves ${NEW}: 5 answers in a row, 7 requests`,
    );
  });

  it("starts the count again when the old version answers in between", async () => {
    const h = host([NEW, NEW, NEW, OLD, NEW]);
    expect(await waitForVersion(h.options)).toBe(9);
  });

  it("counts a failed request or a missing header as not the version", async () => {
    const h = host([NEW, new Error("connection reset"), NEW, null, NEW]);
    expect(await waitForVersion(h.options)).toBe(9);
    expect(h.lines).toContain(
      "attempt 2: https://whichlei.test serves no answer (connection reset)",
    );
    expect(h.lines).toContain("attempt 4: https://whichlei.test serves no version (HTTP 200)");
  });

  it("gives up when the time runs out", async () => {
    const h = host([OLD]);
    await expect(waitForVersion({ ...h.options, timeoutMs: 10_000 })).rejects.toThrow(
      `https://whichlei.test did not serve ${NEW} within 10 s`,
    );
    // Every 2 s from 0 to 10 s.
    expect(h.requests).toHaveLength(6);
  });
});
