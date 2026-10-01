import type { Entry } from "@whichlei/core";
import { describe, expect, it } from "vitest";
import type { Hit } from "../search/entry.ts";
import type { SearchState } from "../search/search.ts";
import { Composer } from "./compose.ts";
import type { LookupHit, LookupState, ReadingState } from "./lookups.ts";

const ERICSSON = "549300W9JLPW15XIFM52";
const OTHER = "AAAAAAAAAAAAAAAAAA01";

const entry = (over: Partial<Entry> = {}): Entry => ({
  lei: "5299004EJJ4TF9C0O947",
  name: "Toyota Motor Corporation",
  otherNames: [],
  country: "JP",
  status: "I",
  prominence: 20,
  ...over,
});

const search = (over: Partial<SearchState> = {}): SearchState => ({
  text: "x",
  phase: "done",
  hits: [{ entry: entry() }],
  tokens: ["x"],
  message: "",
  reload: false,
  lei: null,
  index: null,
  ...over,
});

const hit = (over: Partial<LookupHit> = {}): LookupHit => ({
  lei: ERICSSON,
  name: "Telefonaktiebolaget LM Ericsson",
  country: "SE",
  entityStatus: "ACTIVE",
  registrationStatus: "ISSUED",
  ...over,
});

const reading = (over: Partial<ReadingState> & Pick<ReadingState, "kind">): ReadingState => ({
  code: "X",
  phase: "done",
  hits: [],
  total: 0,
  ...over,
});

const lookups = (...readings: ReadingState[]): LookupState => ({ text: "x", readings });

const typedRow: Hit = { entry: entry({ lei: ERICSSON, name: "", country: "" }), typed: true };

describe("lookup rows", () => {
  it("puts the hits of a lookup above the names, tagged with the reading", () => {
    const out = new Composer().compose(
      search(),
      lookups(reading({ kind: "isin", hits: [hit()], total: 1 })),
    );
    expect(out.state.hits.map((h) => [h.entry.lei, h.via])).toEqual([
      [ERICSSON, "isin"],
      ["5299004EJJ4TF9C0O947", undefined],
    ]);
    expect(out.state.hits[0]).toMatchObject({
      entry: { name: "Telefonaktiebolaget LM Ericsson", country: "SE" },
      status: { label: "active", tone: "active" },
    });
    expect(out.lookups.found).toEqual([{ kind: "isin", shown: 1, total: 1 }]);
  });

  it("shows nothing for a reading with no hits", () => {
    const s = search();
    const out = new Composer().compose(s, lookups(reading({ kind: "bic" })));
    expect(out.state.hits).toBe(s.hits);
    expect(out.lookups.found).toEqual([]);
  });

  it("orders the readings as they come, and shows an entity two readings found once", () => {
    const out = new Composer().compose(
      search({ hits: [] }),
      lookups(
        reading({ kind: "bic", hits: [hit()], total: 1 }),
        reading({ kind: "reg.no", hits: [hit({ lei: OTHER }), hit()], total: 2 }),
      ),
    );
    expect(out.state.hits.map((h) => [h.entry.lei, h.via])).toEqual([
      [ERICSSON, "bic · reg.no"],
      [OTHER, "reg.no"],
    ]);
  });

  it("drops a name that a lookup row already shows", () => {
    const out = new Composer().compose(
      search({ hits: [{ entry: entry({ lei: ERICSSON }) }, { entry: entry() }] }),
      lookups(reading({ kind: "isin", hits: [hit()], total: 1 })),
    );
    expect(out.state.hits.map((h) => h.entry.lei)).toEqual([ERICSSON, "5299004EJJ4TF9C0O947"]);
    expect(out.state.hits[0]?.via).toBe("isin");
  });

  it("turns 'no matches' and 'type a little more' into done when a lookup has hits", () => {
    for (const phase of ["no-match", "short", "unconfigured"] as const) {
      const out = new Composer().compose(
        search({ phase, hits: [] }),
        lookups(reading({ kind: "isin", hits: [hit()], total: 1 })),
      );
      expect(out.state.phase).toBe("done");
    }
  });

  it("leaves the phase alone while the names load", () => {
    const out = new Composer().compose(
      search({ phase: "loading", hits: [] }),
      lookups(reading({ kind: "isin", hits: [hit()], total: 1 })),
    );
    expect(out.state.phase).toBe("loading");
    expect(out.state.hits).toHaveLength(1);
  });

  it("ignores lookups of an input the search has not caught up with", () => {
    const s = search({ text: "older" });
    const out = new Composer().compose(
      s,
      lookups(reading({ kind: "isin", hits: [hit()], total: 1 })),
    );
    expect(out.state).toBe(s);
  });

  it("reports what is pending and what failed", () => {
    const out = new Composer().compose(
      search({ hits: [], phase: "no-match" }),
      lookups(
        reading({ kind: "bic", phase: "loading" }),
        reading({ kind: "isin", phase: "busy" }),
        reading({ kind: "reg.no", phase: "offline" }),
      ),
    );
    expect(out.lookups).toMatchObject({ pending: true, failure: "busy", found: [] });
    expect(out.state.phase).toBe("no-match");
  });
});

describe("the row of an LEI typed in full", () => {
  it("gains its legal name, country and status when GLEIF has it", () => {
    const out = new Composer().compose(
      search({ lei: "valid", hits: [typedRow] }),
      lookups(reading({ kind: "lei", code: ERICSSON, hits: [hit()], total: 1 })),
    );
    expect(out.state.hits).toHaveLength(1);
    expect(out.state.hits[0]).toMatchObject({
      typed: true,
      entry: { lei: ERICSSON, name: "Telefonaktiebolaget LM Ericsson", country: "SE" },
      status: { label: "active" },
    });
    expect(out.lookups.leiMissing).toBe(false);
  });

  it("keeps its place among the names", () => {
    const names = { entry: entry() };
    const out = new Composer().compose(
      search({ lei: "valid", hits: [names, typedRow] }),
      lookups(reading({ kind: "lei", code: ERICSSON, hits: [hit()], total: 1 })),
    );
    expect(out.state.hits.map((h) => h.entry.lei)).toEqual(["5299004EJJ4TF9C0O947", ERICSSON]);
  });

  it("goes when GLEIF has no such LEI, and says so", () => {
    const out = new Composer().compose(
      search({ lei: "valid", hits: [typedRow] }),
      lookups(reading({ kind: "lei", code: ERICSSON })),
    );
    expect(out.state.hits).toEqual([]);
    expect(out.state.phase).toBe("no-match");
    expect(out.lookups.leiMissing).toBe(true);
  });

  it("goes and leaves the names of an LEI-shaped name", () => {
    const out = new Composer().compose(
      search({ lei: "valid", hits: [typedRow, { entry: entry() }] }),
      lookups(reading({ kind: "lei", code: ERICSSON })),
    );
    expect(out.state.hits.map((h) => h.entry.lei)).toEqual(["5299004EJJ4TF9C0O947"]);
    expect(out.state.phase).toBe("done");
  });

  it("stays as it is while GLEIF has not answered, and when it could not", () => {
    for (const phase of ["loading", "busy", "offline"] as const) {
      const out = new Composer().compose(
        search({ lei: "valid", hits: [typedRow] }),
        lookups(reading({ kind: "lei", code: ERICSSON, phase })),
      );
      expect(out.state.hits).toEqual([typedRow]);
      expect(out.lookups.leiMissing).toBe(false);
    }
  });
});

describe("stable arrays", () => {
  it("returns the same hits while the rows are the same, so the page redraws nothing", () => {
    const composer = new Composer();
    const s = search();
    const first = composer.compose(s, lookups(reading({ kind: "isin", hits: [hit()], total: 1 })));
    // The lookups changed (another reading began) but the rows did not.
    const second = composer.compose(
      s,
      lookups(
        reading({ kind: "isin", hits: [hit()], total: 1 }),
        reading({ kind: "bic", phase: "loading" }),
      ),
    );
    expect(second.state.hits).toBe(first.state.hits);
  });

  it("gives the search's own array back when nothing is added", () => {
    const composer = new Composer();
    const s = search();
    expect(
      composer.compose(s, lookups(reading({ kind: "bic", phase: "loading" }))).state.hits,
    ).toBe(s.hits);
  });

  it("returns the same result for the same states", () => {
    const composer = new Composer();
    const s = search();
    const l = lookups(reading({ kind: "isin", hits: [hit()], total: 1 }));
    expect(composer.compose(s, l)).toBe(composer.compose(s, l));
  });
});
