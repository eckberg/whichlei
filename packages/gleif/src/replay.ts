// Test helper: answers requests from the recorded fixtures, so no test touches the network.
// Not exported from the package. Record new fixtures with `pnpm --filter @whichlei/gleif record`.
import { readFileSync } from "node:fs";
import type { Fetch } from "./types.ts";

export interface Fixture {
  url: string;
  status: number;
  contentType: string | null;
  recorded: string;
  body: unknown;
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as Fixture;
}

export interface Replay {
  fetch: Fetch;
  /** Every URL requested, in order. */
  calls: string[];
}

/** Answer with a response of your own. */
export function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Replay {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return new Response(status === 204 ? null : text, { status, headers });
    },
  };
}

/**
 * Answer with a fixture. A request for any URL other than the one recorded fails, so a test
 * passing means the client sends the same request the recording was made with. `edit`
 * returns a changed copy of the body, for cases the recordings do not cover.
 */
export function replay(name: string, edit?: (body: unknown) => unknown): Replay {
  const fixture = loadFixture(name);
  const body = edit ? edit(structuredClone(fixture.body)) : fixture.body;
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      if (url !== fixture.url)
        throw new Error(`Unexpected request ${url}, recorded ${fixture.url}`);
      return new Response(JSON.stringify(body), {
        status: fixture.status,
        headers: { "content-type": fixture.contentType ?? "application/json" },
      });
    },
  };
}
