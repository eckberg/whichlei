// Live lookups at the GLEIF API for the identifiers in the search box: an LEI is confirmed
// (and named), an ISIN, a BIC or a register number is looked up. No DOM, so the tests run it
// with a fake `fetch`.
//
// GLEIF limits requests per IP (about 60 a minute), so: nothing fires while typing goes on
// (`debounceMs` of quiet first), one request per reading, answers are kept for the page
// session, and a request for a reading no longer in the box is aborted.
import {
  type Fetch,
  fetchRecord,
  findByBic,
  findByIsin,
  findByRegisterNumber,
  GleifError,
  type LeiRecord,
  type LeiSummary,
} from "@whichlei/gleif";
import { type LookupReading, lookupReadings, type ReadingKind, readingKey } from "./readings.ts";

/** Quiet time after the last key before the lookups fire. */
export const LOOKUP_DEBOUNCE_MS = 350;
/**
 * The same for a register number, which has no check digit: every prefix of "556016-0680" is
 * one too, so it waits for typing to be over, not just paused.
 */
export const REGISTER_DEBOUNCE_MS = 800;
/** How long one request may take before it counts as not answered. */
export const LOOKUP_TIMEOUT_MS = 8000;
/** The longest wait a Retry-After is believed for, in seconds. */
const MAX_HOLD_SECONDS = 300;
/** The wait when a 429 has no readable Retry-After: browsers hide it from another origin. */
const DEFAULT_HOLD_SECONDS = 60;

/** What a lookup shows per hit: what the result row and the preview need. */
export interface LookupHit {
  lei: string;
  name: string;
  /** ISO 3166-1 alpha-2 of the legal address, or "". */
  country: string;
  entityStatus: string;
  registrationStatus: string;
}

export type LookupPhase =
  /** Typing has not paused yet. */
  | "waiting"
  | "loading"
  | "done"
  /** GLEIF said 429. */
  | "busy"
  /** No answer, or one that makes no sense. */
  | "offline";

export interface ReadingState extends LookupReading {
  phase: LookupPhase;
  /** For `done`. An LEI that GLEIF does not know has none. */
  hits: readonly LookupHit[];
  /** Hits across all pages: more than `hits.length` when GLEIF has more than it was asked for. */
  total: number;
}

export interface LookupState {
  /** The input these readings are of. */
  text: string;
  readings: readonly ReadingState[];
}

export interface LookupOptions {
  /** Defaults to the global `fetch`. */
  fetch?: Fetch;
  debounceMs?: number;
  /** Quiet time for a register number. */
  registerDebounceMs?: number;
  /** Milliseconds before a request that has not answered is given up. */
  timeoutMs?: number;
  /** Milliseconds, like `Date.now`: for the wait a 429 asks for. */
  now?: () => number;
}

interface Answer {
  hits: LookupHit[];
  total: number;
}

const fromSummary = (hit: LeiSummary): LookupHit => ({
  lei: hit.lei,
  name: hit.legalName,
  country: hit.country ?? hit.jurisdiction?.slice(0, 2) ?? "",
  entityStatus: hit.entityStatus,
  registrationStatus: hit.registrationStatus,
});

const fromRecord = (record: LeiRecord): LookupHit => ({
  lei: record.lei,
  name: record.legalName.name,
  country: record.legalAddress?.country ?? record.jurisdiction?.slice(0, 2) ?? "",
  entityStatus: record.entityStatus,
  registrationStatus: record.registrationStatus,
});

const EMPTY: LookupState = { text: "", readings: [] };

export class Lookups {
  readonly #fetch: Fetch | undefined;
  readonly #debounceMs: number;
  readonly #registerDebounceMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #listeners = new Set<(state: LookupState) => void>();
  #state: LookupState = EMPTY;
  /** Answers by reading, for the page session. Failures are not kept: they are retried. */
  readonly #cache = new Map<string, Answer>();
  readonly #inflight = new Map<string, AbortController>();
  #timers: ReturnType<typeof setTimeout>[] = [];
  /** No request until this time: GLEIF said 429 and when to come back. */
  #heldUntil = 0;

  constructor(options: LookupOptions = {}) {
    this.#fetch = options.fetch;
    this.#debounceMs = options.debounceMs ?? LOOKUP_DEBOUNCE_MS;
    this.#registerDebounceMs = options.registerDebounceMs ?? REGISTER_DEBOUNCE_MS;
    this.#timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  get state(): LookupState {
    return this.#state;
  }

  subscribe(listener: (state: LookupState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The text in the search box changed. */
  input(text: string): void {
    this.#clearTimers();
    const readings = lookupReadings(text);
    const keys = new Set(readings.map(readingKey));
    // A request for something no longer in the box is stale.
    for (const [key, controller] of this.#inflight) {
      if (keys.has(key)) continue;
      controller.abort();
      this.#inflight.delete(key);
    }
    if (readings.length === 0) {
      if (this.#state.readings.length > 0) this.#publish({ ...EMPTY, text });
      return;
    }
    const states = readings.map((reading): ReadingState => {
      const key = readingKey(reading);
      const cached = this.#cache.get(key);
      if (cached) return { ...reading, phase: "done", ...cached };
      const phase = this.#inflight.has(key) ? "loading" : "waiting";
      return { ...reading, phase, hits: [], total: 0 };
    });
    this.#publish({ text, readings: states });
    // Each kind waits its own time; the readings that share one are fired together.
    const waits = new Set(
      states.filter((state) => state.phase === "waiting").map((state) => this.#waitFor(state.kind)),
    );
    for (const ms of waits) {
      this.#timers.push(
        setTimeout(() => this.#fire(["waiting"], (kind) => this.#waitFor(kind) === ms), ms),
      );
    }
  }

  #waitFor(kind: ReadingKind): number {
    return kind === "reg.no" ? this.#registerDebounceMs : this.#debounceMs;
  }

  #clearTimers() {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
  }

  /** Ask again for every reading that failed, now. */
  retry(): void {
    this.#clearTimers();
    this.#fire(["busy", "offline"], () => true);
  }

  #fire(from: LookupPhase[], wanted: (kind: ReadingKind) => boolean) {
    const due = this.#state.readings.filter(
      (state) => from.includes(state.phase) && wanted(state.kind),
    );
    if (due.length === 0) return;
    if (this.#now() < this.#heldUntil) {
      // GLEIF asked for time: no request until it has passed.
      for (const reading of due) this.#set(reading, { phase: "busy", hits: [], total: 0 });
      return;
    }
    for (const reading of due) this.#set(reading, { phase: "loading" });
    for (const reading of due) void this.#run(reading);
  }

  async #run(reading: LookupReading) {
    const key = readingKey(reading);
    const controller = new AbortController();
    this.#inflight.set(key, controller);
    try {
      const answer = await query(reading, {
        // Stale (the box moved on) or too slow: either ends the request.
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.#timeoutMs)]),
        ...(this.#fetch ? { fetch: this.#fetch } : {}),
      });
      this.#cache.set(key, answer);
      this.#set(reading, { phase: "done", ...answer });
    } catch (error) {
      if (controller.signal.aborted) return;
      const busy = error instanceof GleifError && error.kind === "rate-limited";
      if (busy) {
        // Browsers hide Retry-After from another origin; when it is there, it is believed.
        const asked = (error as GleifError).retryAfter ?? DEFAULT_HOLD_SECONDS;
        const seconds = Math.min(asked, MAX_HOLD_SECONDS);
        this.#heldUntil = Math.max(this.#heldUntil, this.#now() + seconds * 1000);
      }
      this.#set(reading, { phase: busy ? "busy" : "offline", hits: [], total: 0 });
    } finally {
      if (this.#inflight.get(key) === controller) this.#inflight.delete(key);
    }
  }

  /** Change the state of the reading in the box, if it is still there. */
  #set(reading: LookupReading, patch: Partial<ReadingState>) {
    const key = readingKey(reading);
    if (!this.#state.readings.some((state) => readingKey(state) === key)) return;
    this.#publish({
      ...this.#state,
      readings: this.#state.readings.map((state) =>
        readingKey(state) === key ? { ...state, ...patch } : state,
      ),
    });
  }

  #publish(state: LookupState) {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
}

interface RequestOptions {
  signal: AbortSignal;
  fetch?: Fetch;
}

async function query(reading: LookupReading, options: RequestOptions): Promise<Answer> {
  switch (reading.kind) {
    case "lei":
      try {
        const record = await fetchRecord(reading.code, options);
        // A record for another LEI is an answer that cannot be trusted.
        if (record.lei !== reading.code) {
          throw new GleifError("failed", `GLEIF answered ${record.lei} for ${reading.code}`);
        }
        return { hits: [fromRecord(record)], total: 1 };
      } catch (error) {
        if (error instanceof GleifError && error.kind === "not-found")
          return { hits: [], total: 0 };
        throw error;
      }
    case "isin":
      return answer(await findByIsin(reading.code, options));
    case "bic":
      return answer(await findByBic(reading.code, options));
    case "reg.no":
      return answer(await findByRegisterNumber(reading.code, options));
  }
}

const answer = (page: { items: LeiSummary[]; total: number }): Answer => ({
  hits: page.items.map(fromSummary),
  total: page.total,
});
