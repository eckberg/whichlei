// The search: input text to results. One state machine with no DOM, so the page, the tests
// and tools/bench run the same code.
//
//   text -> identifier readings -> tokens -> route (typing, then paused) -> fetch files
//        -> decode -> merge by LEI -> score (topK) -> results
//
// Typing routes one way and a pause in typing routes another: a wide word such as
// "international" fetches its file only once typing stops (route.ts). Results stay on screen
// while new files load. A newer input makes older ones stale: their fetches are aborted
// (unless the newer one needs the same file) and their answers dropped.
import {
  type Candidate,
  decodeEntries,
  type Entry,
  identifierReadings,
  lastIsPrefix,
  type Manifest,
  queryTokens,
  type RoutingTable,
  route,
  routingTable,
  toCandidate,
  topK,
} from "@whichlei/core";
import { IndexChangedError, IndexError, type IndexSource, isAbort } from "./client.ts";
import type { Hit } from "./entry.ts";

/** Results kept. The list scrolls; nobody reads past the first page. */
export const RESULT_LIMIT = 50;
/** Quiet time after the last key that counts as a pause in typing. */
export const DEBOUNCE_MS = 150;
/** Index files kept decoded and tokenised. A query routes to at most two. */
const PARSED_FILES = 16;

export type Phase =
  /** Nothing typed. */
  | "empty"
  /** No index origin was configured at build time. */
  | "unconfigured"
  /** Waiting for the index; `hits` are the previous results, if any. */
  | "loading"
  /** `hits` answer `text`. */
  | "done"
  /** The index answered and nothing matches. */
  | "no-match"
  /** Too little typed to know which files to read. */
  | "short"
  /** Twenty characters of LEI shape whose check digits fail, and no name matches. */
  | "bad-lei"
  /** The index could not be read. `message` says why. */
  | "error";

export interface SearchState {
  text: string;
  phase: Phase;
  hits: readonly Hit[];
  /** The query's words, as the scorer sees them. What the marks in the list come from. */
  tokens: readonly string[];
  /** Detail for `no-match`, `short` and `error`. */
  message: string;
  /** With `error`: the page is out of date, and reloading it is what helps, not retrying. */
  reload: boolean;
  /**
   * What the input is as an LEI: "valid" (a row for it is in `hits`), "invalid" (twenty
   * characters of that shape whose check digits fail), or null. A name search runs either way.
   */
  lei: "valid" | "invalid" | null;
  /** The published index: date of its GLEIF golden copy and size. Null until it loads. */
  index: { asOf: string; entities: number } | null;
}

/** What one pass cost on the main thread. tools/bench reads it. */
export interface PassStats {
  paused: boolean;
  /** Files the pass routed to. */
  files: number[];
  /** Files it had to decode. Zero when they were already held. */
  parsed: number;
  candidates: number;
  /** The pass changed nothing: same words, same files as the last answer. */
  skipped: boolean;
  /** Milliseconds: tokenise, route, decode, merge and score. Time waiting is not counted. */
  ms: number;
  /** The share of `ms` spent decoding and tokenising newly arrived files. */
  parseMs: number;
}

export interface SearchOptions {
  /** Quiet time that counts as a pause. Infinity: only `pause()` pauses (tools/bench). */
  debounceMs?: number;
  limit?: number;
  /** Clock in milliseconds. `performance.now` by default. */
  now?: () => number;
}

/**
 * What the input is. Names are searched whatever the shape: 621 legal names are an LEI's shape
 * once their spaces are gone, and "ERICSSON" is a valid BIC (DESIGN.md decision 8).
 */
export type Reading =
  | { kind: "empty" }
  | {
      kind: "name";
      tokens: string[];
      lastIsPrefix: boolean;
      /** Length of an input that looks like part of an LEI, for a note when nothing matches. */
      partialLei: number;
      /** The row for a valid LEI. */
      lei: Hit | null;
      /** Twenty characters of LEI shape, no spaces, whose check digits fail. */
      badLei: boolean;
      /** The input has spaces in it: names come before an LEI row. */
      nameFirst: boolean;
    };

// An LEI has this shape before its check digits are looked at. The check itself is core's.
const LEI_SHAPE = /^[0-9A-Z]{18}[0-9]{2}$/;
const PARTIAL_LEI = /^[0-9A-Z]{6,19}$/;
/** Lengths of ISINs (12) and BICs (8, 11): not partial LEIs. Slice 8 looks those up. */
const OTHER_CODES = new Set([8, 11, 12]);

export type NameReading = Extract<Reading, { kind: "name" }>;

/** What `SearchState.lei` says about this input. */
const leiNote = (reading: NameReading): SearchState["lei"] =>
  reading.lei ? "valid" : reading.badLei ? "invalid" : null;

/** A valid LEI typed in full is one row that opens its record. The index cannot look it up. */
function leiRow(lei: string): Hit {
  const entry: Entry = {
    lei,
    name: "",
    otherNames: [],
    country: "",
    status: "I",
    prominence: 0,
  };
  return { entry, typed: true };
}

export function readInput(text: string): Reading {
  if (text.trim() === "") return { kind: "empty" };
  const nameFirst = /\s/.test(text.trim());
  const { lei } = identifierReadings(text);
  // Upper-case a-z only, as identifierReadings does.
  const code = text.replace(/\s+/g, "").replace(/[a-z]/g, (c) => c.toUpperCase());
  const digits = code.match(/[0-9]/g)?.length ?? 0;
  return {
    kind: "name",
    tokens: queryTokens(text),
    lastIsPrefix: lastIsPrefix(text),
    partialLei:
      !nameFirst && PARTIAL_LEI.test(code) && digits >= 3 && !OTHER_CODES.has(code.length)
        ? code.length
        : 0,
    lei: lei === undefined ? null : leiRow(lei),
    badLei: lei === undefined && !nameFirst && LEI_SHAPE.test(code),
    nameFirst,
  };
}

/** The state before anything is typed. `configured`: an index origin was set at build time. */
export function initialState(configured: boolean): SearchState {
  return {
    text: "",
    phase: configured ? "empty" : "unconfigured",
    hits: [],
    tokens: [],
    message: "",
    reload: false,
    lei: null,
    index: null,
  };
}

/**
 * What the page needs of a search: the `Search` itself, or a stand-in that runs it in a Web
 * Worker (page/remote.ts). Answers come through `subscribe`, never as return values.
 */
export interface SearchPort {
  readonly state: SearchState;
  subscribe(listener: (state: SearchState) => void): () => void;
  /** The text in the search box changed. */
  input(text: string): unknown;
  /** Fetch the manifest now. */
  load(): unknown;
  /** Try again after an error. */
  retry(): unknown;
}

type Parsed = (Candidate<string> & { entry: Entry })[];

export class Search {
  readonly #source: IndexSource | null;
  readonly #debounceMs: number;
  readonly #limit: number;
  readonly #now: () => number;
  readonly #listeners = new Set<(state: SearchState) => void>();
  #state: SearchState;
  #manifest: Manifest | null = null;
  #table: RoutingTable | null = null;
  /** Decoded and tokenised files, by build and number, least recently used first. */
  readonly #parsed = new Map<string, Parsed>();
  #generation = 0;
  #controller: AbortController | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #reading: Reading = { kind: "empty" };
  #text = "";
  /** What the last finished pass answered: which words, from which files. */
  /** The candidates of the last file set, merged by LEI: typing on in a word reads the same files. */
  #merged: { key: string; candidates: Parsed } | null = null;
  #answer: { key: string; phase: Phase; hits: readonly Hit[]; message: string } | null = null;
  stats: PassStats | null = null;

  /** `source` is null when no index is configured: only LEIs typed in full work then. */
  constructor(source: IndexSource | null, options: SearchOptions = {}) {
    this.#source = source;
    this.#debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.#limit = options.limit ?? RESULT_LIMIT;
    this.#now = options.now ?? (() => performance.now());
    this.#state = initialState(source !== null);
  }

  get state(): SearchState {
    return this.#state;
  }

  /** Calls `listener` after every change of state. Returns the way to stop. */
  subscribe(listener: (state: SearchState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Fetch the manifest now, so the first keystroke does not wait for it. */
  async load(): Promise<void> {
    if (!this.#source) return;
    try {
      await this.#loadManifest(this.#source);
      if (this.#state.phase === "error" && this.#reading.kind === "empty") {
        this.#set({ phase: "empty", message: "" });
      }
    } catch (error) {
      if (this.#state.phase === "empty") {
        this.#set({ phase: "error", message: describe(error), reload: needsReload(error) });
      }
    }
  }

  /**
   * The text in the search box changed. Routes as typing now, and as a pause once typing has
   * stopped for `debounceMs`. Resolves when the typing pass has answered.
   */
  input(text: string): Promise<void> {
    clearTimeout(this.#timer);
    const generation = ++this.#generation;
    const reading = readInput(text);
    this.#reading = reading;
    this.#text = text;
    if (reading.kind === "empty") {
      this.#stop();
      this.#answer = null;
      const phase = this.#source ? "empty" : "unconfigured";
      if (this.#source) this.#syncBuild(this.#source);
      this.#set({ text, tokens: [], phase, hits: [], message: "", lei: null });
      return Promise.resolve();
    }
    if (!this.#source) {
      // No index to search: a valid LEI still gets its row.
      this.#stop();
      const hits = reading.lei ? [reading.lei] : [];
      const phase = reading.lei ? "done" : reading.badLei ? "bad-lei" : "unconfigured";
      this.#set({ text, tokens: [], phase, hits, message: "", lei: leiNote(reading) });
      return Promise.resolve();
    }
    if (Number.isFinite(this.#debounceMs)) {
      this.#timer = setTimeout(() => void this.pause(), this.#debounceMs);
    }
    return this.#pass(text, reading, generation, false);
  }

  /** Typing has paused: route again, now allowing the files of words still being typed. */
  pause(): Promise<void> {
    clearTimeout(this.#timer);
    const reading = this.#reading;
    if (reading.kind !== "name" || !this.#source) return Promise.resolve();
    return this.#pass(this.#text, reading, ++this.#generation, true);
  }

  /** Try the current input again, after an error. */
  retry(): Promise<void> {
    this.#answer = null;
    if (this.#reading.kind === "empty") {
      void this.input(this.#text);
      return this.load();
    }
    return this.input(this.#text).then(() => this.pause());
  }

  // ---- The pass -----------------------------------------------------------------------

  /** Stop whatever is in flight: its answer would be stale. */
  #stop() {
    this.#controller?.abort();
    this.#controller = null;
  }

  async #loadManifest(source: IndexSource): Promise<Manifest> {
    const manifest = await source.manifest();
    if (manifest !== this.#manifest) {
      this.#manifest = manifest;
      this.#table = routingTable(manifest);
      this.#set({ index: { asOf: manifest.asOf, entities: manifest.entities } });
    }
    return manifest;
  }

  async #pass(
    text: string,
    reading: NameReading,
    generation: number,
    paused: boolean,
    retried = false,
  ): Promise<void> {
    const source = this.#source as IndexSource;
    this.#syncBuild(source);
    const { tokens } = reading;
    const note = leiNote(reading);
    /** Names, and the row of a valid LEI before them, or after them when there are spaces. */
    const arrange = (names: readonly Hit[]): readonly Hit[] => {
      const row = reading.lei;
      if (!row || names.some((hit) => hit.entry.lei === row.entry.lei)) return names;
      return reading.nameFirst ? [...names, row] : [row, ...names];
    };
    const set = (patch: Partial<SearchState>) =>
      this.#set({ text, tokens, lei: note, message: "", ...patch });
    // A valid LEI is on screen at once, before any name has been found.
    const instant = reading.lei && !reading.nameFirst ? { hits: [reading.lei] } : {};
    let busy = 0;
    let mark = this.#now();
    const controller = new AbortController();
    const previous = this.#controller;
    this.#controller = controller;
    try {
      if (!this.#manifest || !this.#table) {
        set({ phase: "loading", ...instant });
        busy += this.#now() - mark;
        await this.#loadManifest(source);
        if (generation !== this.#generation) return;
        mark = this.#now();
      }
      const manifest = this.#manifest as Manifest;
      const files = route(tokens, this.#table as RoutingTable, {
        lastIsPrefix: reading.lastIsPrefix,
        paused,
      });
      const key = `${manifest.build}:${tokens.join(" ")}:${files.join(",")}`;
      const base: PassStats = {
        paused,
        files,
        parsed: 0,
        candidates: 0,
        skipped: false,
        ms: 0,
        parseMs: 0,
      };

      if (files.length === 0) {
        // Nothing to read: too short to route, or a wide word that waits for a pause.
        previous?.abort();
        this.#answer = null;
        const shown = arrange([]);
        if (paused) {
          const phase = shown.length > 0 ? "done" : reading.badLei ? "bad-lei" : "short";
          set({ phase, hits: shown });
        } else {
          set({ phase: "loading", ...instant });
        }
        this.stats = { ...base, ms: busy + this.#now() - mark };
        return;
      }

      if (this.#answer?.key === key) {
        // The same words over the same files as the last answer.
        previous?.abort();
        const { phase, hits, message } = this.#answer;
        set({ phase, hits, message });
        this.stats = { ...base, skipped: true, ms: busy + this.#now() - mark };
        return;
      }

      const wanted = files.map((file) => `${manifest.build}/${file}`);
      const missing = files.filter((_, i) => !this.#parsed.has(wanted[i] as string));
      let texts: string[] = [];
      if (missing.length > 0) {
        // Results stay on screen while these load.
        set({ phase: "loading", ...instant });
        const pending = missing.map((file) => source.file(manifest.build, file, controller.signal));
        // Only now: a file both passes need is already being waited for by this one.
        previous?.abort();
        busy += this.#now() - mark;
        texts = await Promise.all(pending);
        if (generation !== this.#generation) return;
        mark = this.#now();
      } else {
        previous?.abort();
      }

      const parseStart = this.#now();
      for (const [i, file] of missing.entries()) {
        const entries = decodeEntries(texts[i] as string);
        this.#remember(`${manifest.build}/${file}`, entries.map(toCandidate));
      }
      const parseMs = this.#now() - parseStart;

      // Touched: the least recently used file goes first.
      for (const name of wanted) {
        const parsed = this.#parsed.get(name);
        if (!parsed) continue;
        this.#parsed.delete(name);
        this.#parsed.set(name, parsed);
      }
      // The same files as the last pass hold the same candidates (a build's files never
      // change), so they are merged once: typing on in a word asks for the same files.
      const filesKey = `${manifest.build}:${files.join(",")}`;
      let candidates: Parsed;
      if (this.#merged?.key === filesKey) {
        candidates = this.#merged.candidates;
      } else {
        const seen = new Set<string>();
        candidates = [];
        for (const name of wanted) {
          for (const candidate of this.#parsed.get(name) ?? []) {
            if (!seen.has(candidate.id)) {
              seen.add(candidate.id);
              candidates.push(candidate);
            }
          }
        }
        this.#merged = { key: filesKey, candidates };
      }
      const top = topK(tokens, candidates, this.#limit);
      // The same entries in the same order for the same words (a pause pass over files that
      // add nothing to the top): keep the array the page holds, so it has nothing to redraw.
      const held = this.#state.hits;
      const names = top.map(({ entry }) => ({ entry }));
      const arranged = arrange(names);
      const same =
        held.length === arranged.length &&
        this.#state.tokens.join(" ") === tokens.join(" ") &&
        arranged.every((hit, i) => hit.entry === held[i]?.entry);
      const hits: readonly Hit[] = same ? held : arranged;
      const phase = hits.length > 0 ? "done" : reading.badLei ? "bad-lei" : "no-match";
      const message =
        phase === "no-match" && reading.partialLei > 0
          ? `looks like an lei: ${reading.partialLei}/20 characters`
          : "";
      this.#answer = { key, phase, hits, message };
      this.stats = {
        ...base,
        parsed: missing.length,
        candidates: candidates.length,
        ms: busy + this.#now() - mark,
        parseMs,
      };
      set({ phase, hits, message });
    } catch (error) {
      if (error instanceof IndexChangedError) {
        // Republished while the page was open. Whatever this pass was for, what the page holds
        // belongs to the old build: drop it, and read the new manifest, which also moves the
        // date in the footer.
        this.#forgetBuild();
        if (generation !== this.#generation) {
          // This pass is stale, but the query the box holds now may still be answered from the
          // old build or not at all: route it again.
          void this.#reload(source);
          return;
        }
        if (!retried) return this.#pass(text, reading, generation, paused, true);
      }
      if (generation !== this.#generation || isAbort(error)) return;
      this.#answer = null;
      set({
        phase: "error",
        hits: arrange([]),
        message: describe(error),
        reload: needsReload(error),
      });
    }
  }

  /**
   * The source may have moved to another build without this pass hearing of it (a request
   * nobody was waiting for any more met the 404). Whatever is held is of the old build then.
   */
  #syncBuild(source: IndexSource) {
    const now = source.peek();
    if (now === null || this.#manifest === null || now === this.#manifest) return;
    this.#forgetBuild();
    this.#manifest = now;
    this.#table = routingTable(now);
    this.#set({ index: { asOf: now.asOf, entities: now.entities } });
  }

  /** Drop everything that belongs to the build the page has been reading. */
  #forgetBuild() {
    this.#parsed.clear();
    this.#merged = null;
    this.#answer = null;
    this.#manifest = null;
    this.#table = null;
  }

  /** After a republish seen by a stale pass: load the manifest, and answer the current input. */
  async #reload(source: IndexSource) {
    try {
      await this.#loadManifest(source);
    } catch {
      return;
    }
    const reading = this.#reading;
    if (reading.kind === "name") {
      void this.#pass(this.#text, reading, ++this.#generation, true);
    }
  }

  #remember(name: string, parsed: Parsed) {
    this.#parsed.set(name, parsed);
    while (this.#parsed.size > PARSED_FILES) {
      const oldest = this.#parsed.keys().next().value;
      if (oldest === undefined) break;
      this.#parsed.delete(oldest);
    }
  }

  #set(patch: Partial<SearchState>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener(this.#state);
  }
}

/** A page that cannot read the index's format is old: only a reload helps. */
const needsReload = (error: unknown): boolean =>
  error instanceof IndexError && error.kind === "unsupported";

/** A sentence for the person, without the detail of what failed. */
function describe(error: unknown): string {
  if (error instanceof IndexError) {
    if (error.kind === "unsupported") return "this page is out of date: reload it";
    if (error.kind === "format") return "the index is damaged: try again later";
    if (error.kind === "network") return "could not reach the index: check your connection";
  }
  if (error instanceof IndexChangedError) return "the index was republished: type again";
  return "the index could not be read";
}
