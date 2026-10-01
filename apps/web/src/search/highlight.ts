// Which characters of a name the query matched, for the result list. Only the names of
// results that are shown are looked at, so this never touches the candidates being scored.
import { fold, matchLevel } from "@whichlei/core";

/** Half-open range of UTF-16 indexes into the name. */
export type Range = readonly [start: number, end: number];

// biome-ignore lint/suspicious/noControlCharactersInRegex: the whole ASCII range
const ASCII = /^[\x00-\x7f]*$/;
const SPACE = /\s/;
const ALNUM_CHAR = /^[a-z0-9]$/;

/** One alphanumeric word of the name, with where each of its characters ends. */
interface Word {
  text: string;
  start: number;
  /** ends[i] is the end index in the name of the word's character i. */
  ends: number[];
}

/** The folded alphanumeric characters of `name`, each with the span it came from. */
function folded(name: string): { chars: string[]; from: number[]; to: number[]; space: boolean[] } {
  const chars: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  const space: boolean[] = [];
  const push = (char: string, start: number, end: number, isSpace: boolean) => {
    chars.push(char);
    from.push(start);
    to.push(end);
    space.push(isSpace);
  };
  if (ASCII.test(name)) {
    for (let i = 0; i < name.length; i++) {
      const char = (name[i] as string).toLowerCase();
      push(char, i, i + 1, SPACE.test(char));
    }
    return { chars, from, to, space };
  }
  let i = 0;
  for (const point of name) {
    const end = i + point.length;
    const isSpace = SPACE.test(point);
    // `fold` may turn one character into several ("æ" is "ae") or none (a combining mark).
    for (const char of fold(point)) push(char, i, end, isSpace);
    i = end;
  }
  return { chars, from, to, space };
}

/** The alphanumeric words of a name, and the joined forms the tokeniser also makes. */
function words(name: string): Word[] {
  const { chars, from, to, space } = folded(name);
  const singles: Word[] = [];
  const runs: Word[] = [];
  const joined: Word[] = [];
  let chunk: Word[] = [];
  const closeChunk = () => {
    // 'AT&T' and 'Coca-Cola' are also one word, 'attt' and 'cocacola'.
    if (chunk.length >= 2) joined.push(merge(chunk));
    chunk = [];
  };
  let run: Word | null = null;
  const closeRun = () => {
    if (run) {
      runs.push(run);
      chunk.push(run);
      run = null;
    }
  };
  for (let k = 0; k < chars.length; k++) {
    const char = chars[k] as string;
    if (ALNUM_CHAR.test(char)) {
      run ??= { text: "", start: from[k] as number, ends: [] };
      run.text += char;
      run.ends.push(to[k] as number);
    } else {
      closeRun();
      if (space[k]) closeChunk();
    }
  }
  closeRun();
  closeChunk();
  // 'L M Ericsson': adjacent single letters are one word, 'lm'.
  let streak: Word[] = [];
  const closeStreak = () => {
    if (streak.length >= 2) singles.push(merge(streak));
    streak = [];
  };
  for (const word of runs) {
    if (word.text.length === 1) streak.push(word);
    else closeStreak();
  }
  closeStreak();
  return [...runs, ...joined, ...singles];
}

function merge(parts: Word[]): Word {
  return {
    text: parts.map((p) => p.text).join(""),
    start: (parts[0] as Word).start,
    ends: parts.flatMap((p) => p.ends),
  };
}

/**
 * The parts of `name` that the query words matched: for each word, the typed part of the
 * best matching name word, the way the scorer would pick it. Sorted, not overlapping.
 */
export function markRanges(query: readonly string[], name: string): Range[] {
  const candidates = words(name);
  const ranges: [number, number][] = [];
  for (const q of query) {
    let best = 0;
    let pick: Word | undefined;
    for (const word of candidates) {
      const level = matchLevel(q, word.text);
      if (level > best) {
        best = level;
        pick = word;
      }
    }
    if (!pick) continue;
    const typed = Math.min(q.length, pick.text.length);
    ranges.push([pick.start, pick.ends[typed - 1] as number]);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** How a result's names are shown: the legal name marked, or the other name that matched. */
export interface NameMarks {
  /** Marked ranges of the legal name. */
  legal: Range[];
  /** When the legal name has no match: the other name that matched best, and its ranges. */
  aka?: { name: string; ranges: Range[] };
}

export function nameMarks(query: readonly string[], name: string, others: readonly string[]) {
  const legal = markRanges(query, name);
  const marks: NameMarks = { legal };
  if (legal.length > 0) return marks;
  let best = 0;
  for (const other of others) {
    const ranges = markRanges(query, other);
    const size = ranges.reduce((sum, [start, end]) => sum + end - start, 0);
    if (size > best) {
      best = size;
      marks.aka = { name: other, ranges };
    }
  }
  return marks;
}
