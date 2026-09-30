// A query typed one character at a time, as evaluate.session_cost replays it.
import { lastIsPrefix as isPrefix, queryTokens, type RoutingTable, route } from "@whichlei/core";

export interface Keystroke {
  typed: string;
  tokens: string[];
  last: boolean;
  /** Files routed when the debounce fires on this key. */
  paused: number[];
  /** Files routed while typing continues (the debounce has not fired). */
  typing: number[];
}

/** Every keystroke of `query` that has at least one token. */
export function keystrokes(query: string, table: RoutingTable): Keystroke[] {
  const out: Keystroke[] = [];
  for (let k = 1; k <= query.length; k++) {
    const typed = query.slice(0, k);
    const tokens = queryTokens(typed);
    if (tokens.length === 0) continue;
    const lastIsPrefix = isPrefix(typed);
    out.push({
      typed,
      tokens,
      last: k === query.length,
      paused: route(tokens, table, { lastIsPrefix, paused: true }),
      typing: route(tokens, table, { lastIsPrefix, paused: false }),
    });
  }
  return out;
}

/**
 * Files a session fetches. "every key": the debounce fires on every key (fast phone
 * typing against a 150 ms debounce). "last key": it fires only after the last key.
 */
export function sessionFiles(strokes: readonly Keystroke[], debounce: "every key" | "last key") {
  const files = new Set<number>();
  for (const s of strokes) {
    for (const f of debounce === "every key" || s.last ? s.paused : s.typing) files.add(f);
  }
  return files;
}
