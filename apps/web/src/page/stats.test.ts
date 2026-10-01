import { describe, expect, it } from "vitest";
import { SETTLE_MS, SearchCounter } from "./stats.ts";

/** A clock, an idle queue and a sender, all by hand. */
function rig(options: { throws?: boolean } = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const idle: (() => void)[] = [];
  const sent: number[] = [];
  const counter = new SearchCounter({
    schedule: (run, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    cancel: (handle) => {
      timers.delete(handle as number);
    },
    idle: (run) => {
      idle.push(run);
    },
    send: () => {
      sent.push(now);
      if (options.throws) throw new Error("fathom broke");
    },
  });
  return {
    counter,
    sent,
    /** Moves the clock, running the timers that fall due, then the idle queue. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
      for (const run of idle.splice(0)) run();
    },
    pending: () => timers.size,
  };
}

/** The page's order: the box changes, then the results frame is drawn. */
function type(r: ReturnType<typeof rig>, text: string) {
  r.counter.input(text);
  r.counter.shown(text);
}

describe("SearchCounter", () => {
  it("sends nothing while keys come within 2 s of each other", () => {
    const r = rig();
    for (const text of ["e", "er", "eri", "eric", "erics", "ericss"]) {
      type(r, text);
      r.advance(SETTLE_MS - 1);
    }
    expect(r.sent).toEqual([]);
  });

  it("sends one event for a query that holds still for 2 s", () => {
    const r = rig();
    type(r, "e");
    r.advance(500);
    type(r, "ericsson");
    r.advance(SETTLE_MS - 1);
    expect(r.sent).toEqual([]);
    r.advance(1);
    expect(r.sent).toHaveLength(1);
    r.advance(60_000);
    expect(r.sent).toHaveLength(1);
  });

  it("counts a copy before 2 s at once, and nothing after", () => {
    const r = rig();
    type(r, "ericsson");
    r.advance(800);
    r.counter.acted();
    r.advance(0);
    expect(r.sent).toHaveLength(1);
    r.advance(60_000);
    expect(r.sent).toHaveLength(1);
    expect(r.pending()).toBe(0);
  });

  it("counts opening a record the same way", () => {
    const r = rig();
    type(r, "volvo");
    r.counter.acted();
    r.advance(0);
    expect(r.sent).toHaveLength(1);
  });

  it("does not count the same text again, by copy or by waiting", () => {
    const r = rig();
    type(r, "ericsson");
    r.advance(SETTLE_MS);
    type(r, "ericsso");
    type(r, "ericsson");
    r.advance(SETTLE_MS * 2);
    r.counter.acted();
    r.advance(0);
    expect(r.sent).toHaveLength(1);
  });

  it("takes another case or spacing for the same text", () => {
    const r = rig();
    type(r, "ericsson ab");
    r.advance(SETTLE_MS);
    type(r, "  Ericsson   AB ");
    r.advance(SETTLE_MS);
    expect(r.sent).toHaveLength(1);
  });

  it("counts a different text as another search", () => {
    const r = rig();
    type(r, "ericsson");
    r.advance(SETTLE_MS);
    type(r, "volvo");
    r.advance(SETTLE_MS);
    expect(r.sent).toHaveLength(2);
  });

  it("counts nothing for an empty box, or for an act with nothing on screen", () => {
    const r = rig();
    r.counter.acted();
    type(r, "ericsson");
    type(r, "");
    r.advance(SETTLE_MS * 2);
    r.counter.acted();
    r.advance(0);
    expect(r.sent).toEqual([]);
  });

  it("is not pushed back by another frame of the same text, such as a lookup arriving", () => {
    const r = rig();
    type(r, "ericsson");
    r.advance(1500);
    r.counter.shown("ericsson");
    r.advance(500);
    expect(r.sent).toHaveLength(1);
  });

  it("sends from the idle queue, not from the timer", () => {
    const r = rig();
    type(r, "ericsson");
    // Run the timer by hand without draining the idle queue.
    r.advance(SETTLE_MS);
    expect(r.sent).toHaveLength(1);
  });

  it("swallows an error from the sender", () => {
    const r = rig({ throws: true });
    type(r, "ericsson");
    expect(() => r.advance(SETTLE_MS)).not.toThrow();
    expect(r.sent).toHaveLength(1);
  });

  it("holds the query text in memory only: the sender is called with nothing", () => {
    const calls: unknown[][] = [];
    const counter = new SearchCounter({
      schedule: (run) => {
        run();
        return 1;
      },
      cancel: () => {},
      idle: (run) => run(),
      send: (...args: unknown[]) => {
        calls.push(args);
      },
    });
    counter.input("secret name");
    counter.shown("secret name");
    expect(calls).toEqual([[]]);
  });
});
