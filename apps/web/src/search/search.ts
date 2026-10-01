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
  /** Twenty characters that look like an LEI, with check digits that do not verify. */
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

type Reading =
  | { kind: "empty" }
  | { kind: "lei"; lei: string }
  | { kind: "bad-lei" }
  | { kind: "name"; tokens: string[]; lastIsPrefix: boolean; partialLei: number };

// An LEI has this shape before its check digits are looked at. The check itself is core's.
const LEI_SHAPE = /^[0-9A-Z]{18}[0-9]{2}$/;
const PARTIAL_LEI = /^[0-9A-Z]{6,19}$/;

/** What the input is, by its shape and check digits alone (DESIGN.md decisions 8 and 9). */
export function readInput(text: string): Reading {
  if (text.trim() === "") return { kind: "empty" };
  const { lei } = identifierReadings(text);
  if (lei !== undefined) return { kind: "lei", lei };
  // Upper-case a-z only, as identifierReadings does.
  const code = text.replace(/\s+/g, "").replace(/[a-z]/g, (c) => c.toUpperCase());
  if (LEI_SHAPE.test(code)) return { kind: "bad-lei" };
  const digits = code.match(/[0-9]/g)?.length ?? 0;
  return {
    kind: "name",
    tokens: queryTokens(text),
    lastIsPrefix: lastIsPrefix(text),
    partialLei: PARTIAL_LEI.test(code) && digits >= 3 ? code.length : 0,
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
    if (reading.kind !== "name") {
      this.#stop();
      this.#answer = null;
      this.#fixed(text, reading);
      return Promise.resolve();
    }
    if (!this.#source) {
      this.#stop();
      this.#set({ text, phase: "unconfigured", hits: [], tokens: [], message: "" });
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
    if (this.#reading.kind !== "name") {
      void this.input(this.#text);
      return this.load();
    }
    return this.input(this.#text).then(() => this.pause());
  }

  // ---- Inputs that need no index -------------------------------------------------------

  #fixed(text: string, reading: Exclude<Reading, { kind: "name" }>) {
    const base = { text, tokens: [], message: "" };
    if (reading.kind === "empty") {
      const phase = this.#source ? "empty" : "unconfigured";
      this.#set({ ...base, phase, hits: [] });
    } else if (reading.kind === "bad-lei") {
      this.#set({ ...base, phase: "bad-lei", hits: [] });
    } else {
      // A valid LEI is one row that opens its record. The index cannot look an LEI up.
      const entry: Entry = {
        lei: reading.lei,
        name: "",
        otherNames: [],
        country: "",
        status: "I",
        prominence: 0,
      };
      this.#set({ ...base, phase: "done", hits: [{ entry, typed: true }] });
    }
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
    reading: Extract<Reading, { kind: "name" }>,
    generation: number,
    paused: boolean,
    retried = false,
  ): Promise<void> {
    const source = this.#source as IndexSource;
    const { tokens } = reading;
    let busy = 0;
    let mark = this.#now();
    const controller = new AbortController();
    const previous = this.#controller;
    this.#controller = controller;
    try {
      if (!this.#manifest || !this.#table) {
        this.#set({ text, tokens, phase: "loading", message: "" });
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
        if (paused) {
          this.#set({ text, tokens, phase: "short", hits: [], message: "" });
        } else {
          this.#set({ text, tokens, phase: "loading", message: "" });
        }
        this.stats = { ...base, ms: busy + this.#now() - mark };
        return;
      }

      if (this.#answer?.key === key) {
        // The same words over the same files as the last answer.
        previous?.abort();
        const { phase, hits, message } = this.#answer;
        this.#set({ text, tokens, phase, hits, message });
        this.stats = { ...base, skipped: true, ms: busy + this.#now() - mark };
        return;
      }

      const wanted = files.map((file) => `${manifest.build}/${file}`);
      const missing = files.filter((_, i) => !this.#parsed.has(wanted[i] as string));
      let texts: string[] = [];
      if (missing.length > 0) {
        // Results stay on screen while these load.
        this.#set({ text, tokens, phase: "loading", message: "" });
        const pending = missing.map((file) => source.file(file, controller.signal));
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
      const same =
        held.length === top.length &&
        this.#state.tokens.join(" ") === tokens.join(" ") &&
        top.every((c, i) => c.entry === held[i]?.entry);
      const hits: readonly Hit[] = same ? held : top.map(({ entry }) => ({ entry }));
      const phase = hits.length > 0 ? "done" : "no-match";
      const message =
        hits.length === 0 && reading.partialLei > 0
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
      this.#set({ text, tokens, phase, hits, message });
    } catch (error) {
      if (generation !== this.#generation || isAbort(error)) return;
      if (error instanceof IndexChangedError && !retried) {
        // Republished while the page was open: drop what belongs to the old build, route again.
        this.#parsed.clear();
        this.#merged = null;
        this.#answer = null;
        this.#manifest = null;
        this.#table = null;
        return this.#pass(text, reading, generation, paused, true);
      }
      this.#answer = null;
      this.#set({
        text,
        tokens,
        phase: "error",
        hits: [],
        message: describe(error),
        reload: needsReload(error),
      });
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
