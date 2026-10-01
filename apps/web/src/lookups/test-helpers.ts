// A fake GLEIF for the lookup tests: answers from the recorded fixtures, and records what was
// asked. No test touches the network.
import type { Fetch } from "@whichlei/gleif";
import { loadFixture } from "../test-helpers.ts";

export interface Call {
  url: string;
  signal: AbortSignal | undefined;
}

export interface FakeGleif {
  fetch: Fetch;
  calls: Call[];
  /** Calls whose URL contains `part`. */
  matching(part: string): Call[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/vnd.api+json" },
  });

/**
 * Answers lookups by ISIN, BIC and register number with the recorded hits, an ISIN that starts
 * with ZZ with none, and an LEI with its record when a fixture has it, else 404. `override`
 * answers instead, for failures and for holding an answer back.
 */
export function fakeGleif(
  override?: (url: string, init?: RequestInit) => Response | Promise<Response>,
): FakeGleif {
  const calls: Call[] = [];
  return {
    calls,
    matching: (part) => calls.filter((call) => call.url.includes(part)),
    fetch: async (url, init) => {
      calls.push({ url, signal: init?.signal ?? undefined });
      if (override) return override(url, init);
      if (url.includes("filter%5Bisin%5D=ZZ")) return json(loadFixture("lookup-no-hits").body);
      if (url.includes("filter%5Bisin%5D=")) return json(loadFixture("lookup-isin").body);
      if (url.includes("filter%5Bbic%5D=")) return json(loadFixture("lookup-bic").body);
      if (url.includes("filter%5Bentity.registeredAs%5D=")) {
        return json(loadFixture("lookup-register-number").body);
      }
      const lei = /lei-records\/([0-9A-Z]{20})/.exec(url)?.[1];
      const record = loadFixture("record-ericsson");
      if (lei && record.url.includes(lei)) return json(record.body);
      return new Response("<html>Not found</html>", { status: 404 });
    },
  };
}

/** A response that has to be released by hand, to test what happens while a request is out. */
export function held() {
  let release!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export { json };
