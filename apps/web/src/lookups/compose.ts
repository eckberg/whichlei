// Puts what the lookups found next to what the index search found, for the page to show. No
// DOM. Lookup rows come first, then the names (DESIGN.md decision 8: a reading with no hits
// shows nothing). An LEI row from the search gains its legal name and status once GLEIF has
// answered, or goes if GLEIF has no such LEI.
import type { Entry } from "@whichlei/core";
import type { Hit } from "../search/entry.ts";
import type { SearchState } from "../search/search.ts";
import { stateOf } from "../status.ts";
import type { LookupHit, LookupState } from "./lookups.ts";
import type { ReadingKind } from "./readings.ts";

export interface LookupSummary {
  /** The input is a valid LEI that GLEIF does not know. */
  leiMissing: boolean;
  /** The readings that have hits, in row order. `total` counts hits GLEIF has beyond `shown`. */
  found: readonly { kind: ReadingKind; shown: number; total: number }[];
  /** A lookup has not answered yet. */
  pending: boolean;
  /** A lookup failed: GLEIF said 429, or could not be reached. The first one wins. */
  failure: "busy" | "offline" | null;
}

export const NO_LOOKUPS: LookupSummary = {
  leiMissing: false,
  found: [],
  pending: false,
  failure: null,
};

export interface Composed {
  state: SearchState;
  lookups: LookupSummary;
}

function toHit(hit: LookupHit, extra: Pick<Hit, "typed" | "via">): Hit {
  const entry: Entry = {
    lei: hit.lei,
    name: hit.name,
    otherNames: [],
    country: hit.country,
    // The row shows `status`, which has GLEIF's own words; this is only the closest letter.
    status: hit.entityStatus === "INACTIVE" ? "r" : "I",
    prominence: 0,
  };
  return { entry, status: stateOf(hit.entityStatus, hit.registrationStatus), ...extra };
}

const sameHit = (a: Hit, b: Hit) =>
  a.entry === b.entry ||
  (a.entry.lei === b.entry.lei &&
    a.entry.name === b.entry.name &&
    a.entry.country === b.entry.country &&
    a.typed === b.typed &&
    a.via === b.via &&
    a.status?.label === b.status?.label &&
    a.status?.tone === b.status?.tone);

/**
 * Composes search and lookup states. It keeps the array of hits it last returned while the
 * rows have not changed, so the page, which redraws when the array changes, redraws nothing.
 */
export class Composer {
  #hits: readonly Hit[] = [];
  #last: { search: SearchState; lookups: LookupState; out: Composed } | null = null;

  compose(search: SearchState, lookups: LookupState): Composed {
    const last = this.#last;
    if (last && last.search === search && last.lookups === lookups) return last.out;
    const out = this.#compose(search, lookups);
    this.#last = { search, lookups, out };
    return out;
  }

  #compose(search: SearchState, lookups: LookupState): Composed {
    // A search that has not caught up with the box is not the one these readings are of.
    if (lookups.readings.length === 0 || lookups.text !== search.text) {
      return { state: search, lookups: NO_LOOKUPS };
    }
    const rows = new Map<string, Hit>();
    const found: { kind: ReadingKind; shown: number; total: number }[] = [];
    let leiHit: LookupHit | null = null;
    let leiMissing = false;
    let pending = false;
    let failure: LookupSummary["failure"] = null;

    for (const reading of lookups.readings) {
      if (reading.phase === "waiting" || reading.phase === "loading") pending = true;
      else if (reading.phase === "busy" || reading.phase === "offline") {
        failure ??= reading.phase;
      } else if (reading.kind === "lei") {
        leiHit = reading.hits[0] ?? null;
        leiMissing = leiHit === null;
      } else if (reading.hits.length > 0) {
        found.push({ kind: reading.kind, shown: reading.hits.length, total: reading.total });
        for (const hit of reading.hits) {
          const before = rows.get(hit.lei);
          // An entity that two readings found is one row, with both tags.
          rows.set(
            hit.lei,
            toHit(hit, { via: before?.via ? `${before.via} · ${reading.kind}` : reading.kind }),
          );
        }
      }
    }

    // The row of an LEI typed in full, with what GLEIF says about it.
    let names = search.hits;
    const typed = names.findIndex((hit) => hit.typed && hit.entry.name === "");
    if (typed >= 0) {
      const lei = names[typed]?.entry.lei;
      if (leiHit && leiHit.lei === lei) {
        names = names.map((hit, i) =>
          i === typed ? toHit(leiHit as LookupHit, { typed: true }) : hit,
        );
      } else if (leiMissing) {
        names = names.filter((_, i) => i !== typed);
      }
    }
    names = names.filter((hit) => !rows.has(hit.entry.lei));

    const next = [...rows.values(), ...names];
    const hits = this.#reuse(next, search);
    let phase = search.phase;
    if (hits.length > 0 && ["no-match", "short", "unconfigured", "bad-lei"].includes(phase)) {
      phase = "done";
    } else if (hits.length === 0 && phase === "done") {
      phase = "no-match";
    }
    const state: SearchState =
      hits === search.hits && phase === search.phase ? search : { ...search, hits, phase };
    return { state, lookups: { leiMissing, found, pending, failure } };
  }

  /** The array held before, if `next` holds the same rows: nothing then needs to redraw. */
  #reuse(next: readonly Hit[], search: SearchState): readonly Hit[] {
    // Nothing from the lookups: the search's own array, which it keeps stable itself.
    if (next.length === search.hits.length && next.every((hit, i) => hit === search.hits[i])) {
      this.#hits = search.hits;
      return search.hits;
    }
    const held = this.#hits;
    if (held.length === next.length && held.every((hit, i) => sameHit(hit, next[i] as Hit))) {
      return held;
    }
    this.#hits = next;
    return next;
  }
}
