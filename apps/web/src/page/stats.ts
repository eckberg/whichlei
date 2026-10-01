// The search counter (DESIGN.md decision 31): one Fathom event, `search`, per settled query.
//
// A query settles when its results are on screen and the box has not changed for SETTLE_MS, or
// at once when the person copies an LEI or opens a record. A query text counts once per page
// load. Nothing about the query leaves the page: the event has no payload, and the text is kept
// only in memory, to count it once.
//
// Pure: the clock, the idle callback and the sender are injected. The page calls `shown` after
// it has rendered a results frame, never before, and nothing here runs on the typing path
// beyond arming or clearing one timer.

/** How long the box must hold still, with its results on screen, before a query counts. */
export const SETTLE_MS = 2000;

export interface StatsDeps {
  /** `setTimeout`. Returns what `cancel` takes. */
  schedule(run: () => void, ms: number): unknown;
  /** `clearTimeout`. */
  cancel(handle: unknown): void;
  /** `requestIdleCallback`, or `setTimeout(run, 0)` where there is none. */
  idle(run: () => void): void;
  /** Sends one `search` event. May throw; the counter swallows it. */
  send(): void;
}

/** A query's identity for "once per page load": case and spacing do not make a new search. */
const key = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

export class SearchCounter {
  readonly #deps: StatsDeps;
  readonly #settleMs: number;
  /** Queries already counted, in this page load. Memory only. */
  readonly #counted = new Set<string>();
  /** The query whose results are on screen, or null. */
  #showing: string | null = null;
  #timer: unknown = null;

  constructor(deps: StatsDeps, settleMs: number = SETTLE_MS) {
    this.#deps = deps;
    this.#settleMs = settleMs;
  }

  /** The box changed. Whatever was about to count is off until its results are shown. */
  input(text: string): void {
    this.#disarm();
    if (key(text) === "") this.#showing = null;
  }

  /**
   * A results frame for `text` was drawn and the box still holds it. Arms the timer, unless
   * this text is already counted or already waiting (a later frame of the same text, such as
   * a lookup arriving, does not push the count back).
   */
  shown(text: string): void {
    const k = key(text);
    if (k === "") {
      this.#showing = null;
      this.#disarm();
      return;
    }
    if (this.#showing === k && this.#timer !== null) return;
    this.#showing = k;
    this.#disarm();
    if (this.#counted.has(k)) return;
    this.#timer = this.#deps.schedule(() => {
      this.#timer = null;
      this.#count();
    }, this.#settleMs);
  }

  /** An LEI was copied or a record opened: the query on screen counts now. */
  acted(): void {
    this.#disarm();
    this.#count();
  }

  #disarm(): void {
    if (this.#timer === null) return;
    this.#deps.cancel(this.#timer);
    this.#timer = null;
  }

  #count(): void {
    const k = this.#showing;
    if (k === null || this.#counted.has(k)) return;
    this.#counted.add(k);
    this.#deps.idle(() => {
      try {
        this.#deps.send();
      } catch {
        // Analytics never break the page.
      }
    });
  }
}

interface FathomLike {
  trackEvent?: (name: string) => void;
}

/** The counter wired to the browser: real timers, the idle callback, and Fathom if it loaded. */
export function browserCounter(): SearchCounter {
  return new SearchCounter({
    schedule: (run, ms) => setTimeout(run, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    idle: (run) => {
      // The timeout keeps a count from waiting for ever on a busy page, and the page may be
      // about to leave (an opened record).
      if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1000 });
      else setTimeout(run, 0);
    },
    send: () => {
      (window as { fathom?: FathomLike }).fathom?.trackEvent?.("search");
    },
  });
}
