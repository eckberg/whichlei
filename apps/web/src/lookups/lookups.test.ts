import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../test-helpers.ts";
import { LOOKUP_DEBOUNCE_MS, type LookupState, Lookups, REGISTER_DEBOUNCE_MS } from "./lookups.ts";
import { fakeGleif, held, json } from "./test-helpers.ts";

const ERICSSON = "549300W9JLPW15XIFM52";
const ISIN = "SE0000108656";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Let the lookups fire, and the answers (promises) arrive. */
async function settle(ms = LOOKUP_DEBOUNCE_MS) {
  await vi.advanceTimersByTimeAsync(ms);
}

function setup(override?: Parameters<typeof fakeGleif>[0]) {
  const gleif = fakeGleif(override);
  const lookups = new Lookups({ fetch: gleif.fetch });
  const states: LookupState[] = [];
  lookups.subscribe((state) => states.push(state));
  return { gleif, lookups, states };
}

const phases = (lookups: Lookups) =>
  Object.fromEntries(lookups.state.readings.map((reading) => [reading.kind, reading.phase]));

describe("the pause", () => {
  it("asks nothing until typing has paused for 350 ms", async () => {
    const { gleif, lookups } = setup();
    lookups.input(ISIN);
    expect(phases(lookups)).toEqual({ isin: "waiting" });
    await settle(LOOKUP_DEBOUNCE_MS - 1);
    expect(gleif.calls).toEqual([]);
    await settle(1);
    expect(gleif.calls).toHaveLength(1);
    expect(phases(lookups)).toEqual({ isin: "done" });
  });

  it("starts the wait again at every change of the input", async () => {
    const { gleif, lookups } = setup();
    lookups.input(ISIN);
    await settle(300);
    lookups.input(`${ISIN} `);
    await settle(300);
    expect(gleif.calls).toEqual([]);
    await settle(50);
    expect(gleif.calls).toHaveLength(1);
  });

  it("asks nothing for what has no identifier in it", async () => {
    const { gleif, lookups, states } = setup();
    lookups.input("telefonaktiebolaget lm ericsson");
    await settle(2000);
    expect(gleif.calls).toEqual([]);
    expect(states).toEqual([]);
    expect(lookups.state.readings).toEqual([]);
  });

  it("clears the readings when the input stops having one", async () => {
    const { lookups } = setup();
    lookups.input(ISIN);
    lookups.input("");
    await settle(2000);
    expect(lookups.state.readings).toEqual([]);
  });

  it("sends one request when an LEI is typed one key at a time, for the last key", async () => {
    const { gleif, lookups } = setup();
    for (let i = 1; i <= ERICSSON.length; i++) {
      lookups.input(ERICSSON.slice(0, i));
      await settle(40);
    }
    await settle(LOOKUP_DEBOUNCE_MS);
    expect(gleif.calls).toHaveLength(1);
    expect(gleif.calls[0]?.url).toContain(`/lei-records/${ERICSSON}`);
  });
});

describe("one request per reading", () => {
  it("confirms an LEI with its record, and names it", async () => {
    const { gleif, lookups } = setup();
    lookups.input(ERICSSON.toLowerCase());
    await settle();
    expect(gleif.calls).toHaveLength(1);
    expect(lookups.state.readings).toEqual([
      {
        kind: "lei",
        code: ERICSSON,
        phase: "done",
        total: 1,
        hits: [
          {
            lei: ERICSSON,
            name: "Telefonaktiebolaget LM Ericsson",
            country: "SE",
            entityStatus: "ACTIVE",
            registrationStatus: "ISSUED",
          },
        ],
      },
    ]);
  });

  it("answers an LEI GLEIF does not have with no hits, not an error", async () => {
    const { lookups } = setup();
    lookups.input("549300ZZZZZZZZZZZZ46");
    await settle();
    expect(lookups.state.readings).toMatchObject([{ kind: "lei", phase: "done", hits: [] }]);
  });

  it("looks up an ISIN, with the hits GLEIF has", async () => {
    const { gleif, lookups } = setup();
    lookups.input(ISIN);
    await settle();
    expect(gleif.calls).toHaveLength(1);
    expect(gleif.calls[0]?.url).toContain("filter%5Bisin%5D=SE0000108656");
    expect(lookups.state.readings[0]).toMatchObject({
      kind: "isin",
      phase: "done",
      total: 1,
      hits: [{ lei: "549300W9JLPW15XIFM52", country: "SE" }],
    });
  });

  it("looks up an 8-character BIC as its primary office, and an 11-character one as it is", async () => {
    const eight = setup();
    eight.lookups.input("tomcjp22");
    await settle();
    expect(eight.gleif.calls.map((call) => call.url)).toHaveLength(1);
    expect(eight.gleif.calls[0]?.url).toContain("filter%5Bbic%5D=TOMCJP22XXX");
    expect(eight.lookups.state.readings[0]).toMatchObject({ kind: "bic", phase: "done" });
    expect(eight.lookups.state.readings[0]?.hits.length).toBeGreaterThan(0);

    const eleven = setup();
    eleven.lookups.input("TOMCJP22XXX");
    await settle();
    expect(eleven.gleif.calls[0]?.url).toContain("filter%5Bbic%5D=TOMCJP22XXX");
  });

  it("looks up a register number as typed, with the exact matches first", async () => {
    const { gleif, lookups } = setup((url) => {
      const body = structuredClone(loadFixture("lookup-register-number").body) as {
        data: { attributes: { entity: { registeredAs: string } } }[];
      };
      // GLEIF matches whole words: the first hit is a longer number, the last is the one asked.
      const numbers = ["HRB 30000 B", "HRB 30000 A", "hrb 30000"];
      for (const [i, hit] of body.data.entries()) {
        hit.attributes.entity.registeredAs = numbers[i] ?? "";
      }
      return json(body, url.includes("registeredAs") ? 200 : 404);
    });
    lookups.input(" HRB  30000 ");
    await settle(REGISTER_DEBOUNCE_MS);
    expect(gleif.calls).toHaveLength(1);
    expect(gleif.calls[0]?.url).toContain("filter%5Bentity.registeredAs%5D=HRB+30000");
    const reading = lookups.state.readings[0];
    expect(reading).toMatchObject({ kind: "reg.no", phase: "done", total: 3 });
    expect(reading?.hits).toHaveLength(3);
    expect(reading?.hits[0]?.lei).toBe(
      (loadFixture("lookup-register-number").body as { data: { id: string }[] }).data[2]?.id,
    );
  });

  it("asks once for each reading of an input that has two", async () => {
    const { gleif, lookups } = setup();
    lookups.input("1234DE56");
    await settle(REGISTER_DEBOUNCE_MS);
    expect(gleif.calls).toHaveLength(2);
    expect(phases(lookups)).toEqual({ bic: "done", "reg.no": "done" });
  });

  it("asks for a name that is a valid BIC, and shows nothing when GLEIF has no entity", async () => {
    const { gleif, lookups } = setup((url) =>
      json(loadFixture("lookup-no-hits").body, url.includes("bic") ? 200 : 404),
    );
    lookups.input("ericsson");
    await settle();
    expect(gleif.calls).toHaveLength(1);
    expect(gleif.calls[0]?.url).toContain("filter%5Bbic%5D=ERICSSONXXX");
    expect(lookups.state.readings[0]).toMatchObject({ kind: "bic", phase: "done", hits: [] });
  });
});

describe("the cache", () => {
  it("answers an input asked before without a request, however it is written", async () => {
    const { gleif, lookups } = setup();
    lookups.input(ISIN);
    await settle();
    expect(gleif.calls).toHaveLength(1);
    lookups.input("");
    lookups.input(ISIN.toLowerCase());
    // At once: no waiting, no request.
    expect(phases(lookups)).toEqual({ isin: "done" });
    expect(lookups.state.readings[0]?.hits).toHaveLength(1);
    await settle(2000);
    expect(gleif.calls).toHaveLength(1);
  });

  it("keeps an LEI that GLEIF does not have, too", async () => {
    const { gleif, lookups } = setup();
    lookups.input("549300ZZZZZZZZZZZZ46");
    await settle();
    lookups.input("");
    lookups.input("549300ZZZZZZZZZZZZ46");
    await settle(2000);
    expect(gleif.calls).toHaveLength(1);
    expect(lookups.state.readings[0]).toMatchObject({ phase: "done", hits: [] });
  });

  it("does not keep a failure", async () => {
    let answer = 429;
    const { gleif, lookups } = setup((_url) =>
      answer === 200 ? json(loadFixture("lookup-isin").body) : new Response("", { status: answer }),
    );
    lookups.input(ISIN);
    await settle();
    expect(phases(lookups)).toEqual({ isin: "busy" });
    answer = 200;
    // GLEIF gave no Retry-After: no request goes for the next 60 s.
    await settle(61_000);
    lookups.input("");
    lookups.input(ISIN);
    await settle();
    expect(gleif.calls).toHaveLength(2);
    expect(phases(lookups)).toEqual({ isin: "done" });
  });
});

describe("stale requests", () => {
  it("aborts a request whose reading has left the box, and drops its answer", async () => {
    const slow = held();
    const { gleif, lookups } = setup((url) =>
      url.includes("isin") ? slow.promise : json(loadFixture("lookup-bic").body),
    );
    lookups.input(ISIN);
    await settle();
    const signal = gleif.calls[0]?.signal;
    expect(signal?.aborted).toBe(false);
    expect(phases(lookups)).toEqual({ isin: "loading" });

    lookups.input("tomcjp22");
    expect(signal?.aborted).toBe(true);
    slow.release(json(loadFixture("lookup-isin").body));
    await settle();
    expect(phases(lookups)).toEqual({ bic: "done" });
  });

  it("lets a request go on when its reading is still in the box", async () => {
    const slow = held();
    const { gleif, lookups } = setup(() => slow.promise);
    lookups.input(ISIN);
    await settle();
    lookups.input(`  ${ISIN}`);
    expect(phases(lookups)).toEqual({ isin: "loading" });
    await settle(2000);
    expect(gleif.calls).toHaveLength(1);
    expect(gleif.calls[0]?.signal?.aborted).toBe(false);
    slow.release(json(loadFixture("lookup-isin").body));
    await settle(0);
    expect(phases(lookups)).toEqual({ isin: "done" });
  });

  it("does not ask when the input moved on during the wait", async () => {
    const { gleif, lookups } = setup();
    lookups.input(ISIN);
    lookups.input("ericsson telefon");
    await settle(2000);
    expect(gleif.calls).toEqual([]);
  });
});

describe("failures", () => {
  it("calls a 429 busy", async () => {
    const { lookups } = setup(
      () => new Response("", { status: 429, headers: { "retry-after": "30" } }),
    );
    lookups.input(ISIN);
    await settle();
    expect(lookups.state.readings[0]).toMatchObject({ phase: "busy", hits: [] });
  });

  it.each([
    ["no network", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a server error", () => Promise.resolve(new Response("", { status: 500 }))],
    ["a body that is not JSON", () => Promise.resolve(new Response("<html>", { status: 200 }))],
  ])("calls %s offline", async (_, answer) => {
    const { lookups } = setup(answer);
    lookups.input(ISIN);
    await settle();
    expect(lookups.state.readings[0]).toMatchObject({ phase: "offline", hits: [] });
  });

  it("calls an answer for another LEI offline, and shows nothing of it", async () => {
    const { lookups } = setup(() => json(loadFixture("record-ericsson").body));
    lookups.input("5299004EJJ4TF9C0O947");
    await settle();
    expect(lookups.state.readings[0]).toMatchObject({ kind: "lei", phase: "offline", hits: [] });
  });

  it("fails one reading and not the other", async () => {
    const { lookups } = setup((url) =>
      url.includes("bic")
        ? json(loadFixture("lookup-bic").body)
        : new Response("", { status: 429 }),
    );
    lookups.input("1234DE56");
    await settle(REGISTER_DEBOUNCE_MS);
    expect(phases(lookups)).toEqual({ bic: "done", "reg.no": "busy" });
  });

  it("asks again at once on retry, only for what failed", async () => {
    let up = false;
    const { gleif, lookups } = setup((url) => {
      if (url.includes("bic")) return json(loadFixture("lookup-bic").body);
      return up
        ? json(loadFixture("lookup-register-number").body)
        : new Response("", { status: 429 });
    });
    lookups.input("1234DE56");
    await settle(REGISTER_DEBOUNCE_MS);
    expect(gleif.calls).toHaveLength(2);
    up = true;
    await settle(61_000);
    lookups.retry();
    expect(phases(lookups)).toEqual({ bic: "done", "reg.no": "loading" });
    await settle(0);
    expect(gleif.calls).toHaveLength(3);
    expect(phases(lookups)).toEqual({ bic: "done", "reg.no": "done" });
  });

  it("does nothing on retry when nothing failed", async () => {
    const { gleif, lookups } = setup();
    lookups.input(ISIN);
    await settle();
    lookups.retry();
    await settle(2000);
    expect(gleif.calls).toHaveLength(1);
  });
});

describe("a register number waits for typing to be over", () => {
  it("fires 800 ms after the last key, and an ISIN or BIC beside it after 350", async () => {
    const { gleif, lookups } = setup();
    lookups.input("1234DE56");
    await settle(LOOKUP_DEBOUNCE_MS);
    expect(gleif.calls).toHaveLength(1);
    expect(gleif.calls[0]?.url).toContain("filter%5Bbic%5D");
    await settle(REGISTER_DEBOUNCE_MS - LOOKUP_DEBOUNCE_MS - 1);
    expect(gleif.calls).toHaveLength(1);
    await settle(1);
    expect(gleif.calls).toHaveLength(2);
    expect(gleif.calls[1]?.url).toContain("entity.registeredAs");
  });

  it("sends one request for a register number typed at 400 ms a key", async () => {
    const { gleif, lookups } = setup();
    const typed = "556016-0680";
    for (let i = 1; i <= typed.length; i++) {
      lookups.input(typed.slice(0, i));
      await settle(400);
    }
    await settle(REGISTER_DEBOUNCE_MS);
    expect(gleif.calls).toHaveLength(1);
    expect(gleif.calls[0]?.url).toContain("entity.registeredAs%5D=556016-0680");
  });
});

describe("a request that does not answer", () => {
  it("ends as offline after the timeout, with a retry that asks again", async () => {
    vi.useRealTimers();
    let hang = true;
    const gleif = fakeGleif((_url, init) =>
      hang
        ? new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          })
        : json(loadFixture("lookup-isin").body),
    );
    const lookups = new Lookups({ fetch: gleif.fetch, debounceMs: 1, timeoutMs: 40 });
    lookups.input(ISIN);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(phases(lookups)).toEqual({ isin: "loading" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(phases(lookups)).toEqual({ isin: "offline" });
    hang = false;
    lookups.retry();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(phases(lookups)).toEqual({ isin: "done" });
    expect(gleif.calls).toHaveLength(2);
  });
});

describe("Retry-After", () => {
  const busy = (seconds: number | null) => () =>
    new Response("", {
      status: 429,
      ...(seconds === null ? {} : { headers: { "retry-after": String(seconds) } }),
    });

  it("holds every lookup until it has passed, showing the busy state", async () => {
    const { gleif, lookups } = setup(busy(30));
    lookups.input(ISIN);
    await settle();
    expect(phases(lookups)).toEqual({ isin: "busy" });
    expect(gleif.calls).toHaveLength(1);

    // Another input, and a retry: nothing is asked while GLEIF has asked for time.
    lookups.input("tomcjp22");
    await settle();
    expect(phases(lookups)).toEqual({ bic: "busy" });
    lookups.retry();
    expect(phases(lookups)).toEqual({ bic: "busy" });
    await settle(28_000);
    lookups.retry();
    expect(gleif.calls).toHaveLength(1);

    // Past it, a retry asks.
    await settle(3000);
    lookups.retry();
    expect(phases(lookups)).toEqual({ bic: "loading" });
    expect(gleif.calls).toHaveLength(2);
  });

  it("does not believe an absurd wait", async () => {
    const absurd = setup(busy(86_400));
    absurd.lookups.input(ISIN);
    await settle();
    await settle(299_000);
    absurd.lookups.retry();
    expect(absurd.gleif.calls).toHaveLength(1);
    await settle(2000);
    absurd.lookups.retry();
    expect(absurd.gleif.calls).toHaveLength(2);
  });

  it("holds 60 seconds when a 429 has no readable Retry-After", async () => {
    const none = setup(busy(null));
    none.lookups.input(ISIN);
    await settle();
    expect(phases(none.lookups)).toEqual({ isin: "busy" });
    none.lookups.retry();
    expect(none.gleif.calls).toHaveLength(1);
    expect(phases(none.lookups)).toEqual({ isin: "busy" });
    await settle(59_000);
    none.lookups.retry();
    expect(none.gleif.calls).toHaveLength(1);
    await settle(2000);
    none.lookups.retry();
    expect(none.gleif.calls).toHaveLength(2);
  });
});

describe("cookies", () => {
  it("asks GLEIF without credentials by default, so its Set-Cookie is ignored", async () => {
    const gleif = fakeGleif();
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init);
      return gleif.fetch(String(input), init);
    });
    try {
      const lookups = new Lookups();
      lookups.input(ISIN);
      await settle();
      expect(inits).toHaveLength(1);
      expect(inits[0]?.credentials).toBe("omit");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
