// Query-time scoring. Port of research/ranking/ranking.py, section 4, with legal-form
// stripping off (the recommended configuration), so the core name is the whole name.
import type { NameTokens } from "./tokens.ts";

/** Fitted match weights (ranking.py W_RECOMMENDED). The prominence weights come with the indexer. */
export const MATCH_WEIGHTS = {
  /** Every content word matched. */
  m_all: 2.59,
  /** Per unmatched content word. */
  m_miss: 4.83,
  /** Per word matched only within one edit. */
  m_fuzzy: 1.19,
  /** Times the share of query words equal to a whole name word. */
  m_exact: 2.96,
  /** Query equals the name, word for word. */
  m_core_exact: 0.55,
  /** Query is a word prefix of the name. */
  m_prefix: 0.84,
  /** Times the share of name words matched. */
  m_coverage: 2.26,
} as const;

export type MatchWeights = Record<keyof typeof MATCH_WEIGHTS, number>;

/** Query tokens shorter than this never match fuzzily. */
const FUZZY_MIN_LENGTH = 4;

/**
 * Optional query words: an unmatched one is not a miss, and a name that matches only these
 * words is not shown ('republic of latvia' must not surface 'Bank of America').
 */
export const QUERY_STOP: ReadonlySet<string> = new Set(
  "the of and de du des la le les der die das und et y for in van von di del da do a an".split(" "),
);

/**
 * True if some prefix of `term` is within one edit (insert, delete, substitute, adjacent
 * transpose) of `query`. Optimal string alignment, only the band that can stay within 1.
 * Indexes UTF-16 units where Python indexes code points; the same for tokens, which are ASCII.
 */
export function prefixEditLe1(query: string, term: string): boolean {
  const n = query.length;
  const m = term.length;
  if (m < n - 1) return false;
  const INF = 9;
  if (editRows[0].length <= m)
    editRows = [0, 1, 2].map(() => new Int32Array(2 * m + 2)) as EditRows;
  // Three rows of the table, reused across calls: scoring calls this for most name words.
  let [prev2, prev, cur] = editRows;
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur.fill(INF, 1, m + 1);
    cur[0] = i;
    const q = query.charCodeAt(i - 1);
    for (let j = Math.max(1, i - 1); j <= Math.min(m, i + 1); j++) {
      const cost = q === term.charCodeAt(j - 1) ? 0 : 1;
      let d = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        q === term.charCodeAt(j - 2) &&
        query.charCodeAt(i - 2) === term.charCodeAt(j - 1)
      ) {
        d = Math.min(d, (prev2[j - 2] as number) + 1);
      }
      cur[j] = d;
    }
    const oldest = prev2;
    prev2 = prev;
    prev = cur;
    cur = oldest;
  }
  // The query is fully consumed; any prefix of the term may remain.
  for (let j = Math.max(0, n - 1); j <= Math.min(m, n + 1); j++) {
    if ((prev[j] as number) <= 1) return true;
  }
  return false;
}

type EditRows = [Int32Array, Int32Array, Int32Array];
let editRows: EditRows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)];

/** 3 exact word, 2 prefix, 1 fuzzy prefix (one edit), 0 none. */
export function matchLevel(query: string, term: string): 0 | 1 | 2 | 3 {
  if (term === query) return 3;
  if (term.startsWith(query)) return 2;
  if (query.length >= FUZZY_MIN_LENGTH && prefixEditLe1(query, term)) return 1;
  return 0;
}

export interface MatchFeatures {
  n: number;
  shown: boolean;
  nMiss: number;
  nFuzzy: number;
  nExact: number;
  exact: boolean;
  prefix: boolean;
  coverage: number;
}

/** A match level function: matchLevel, or a memo of it. */
export type Level = (query: string, term: string) => number;

/** matchLevel, remembering every answer. Names in one index file share most of their words. */
export function memoLevel(): Level {
  const memo = new Map<string, Map<string, number>>();
  return (query, term) => {
    let levels = memo.get(query);
    if (!levels) {
      levels = new Map();
      memo.set(query, levels);
    }
    let level = levels.get(term);
    if (level === undefined) {
      level = matchLevel(query, term);
      levels.set(term, level);
    }
    return level;
  };
}

/** Features of one name against the query tokens. The last query token may be partial. */
export function matchFeatures(
  query: string[],
  { seq, extras }: NameTokens,
  level: Level = matchLevel,
): MatchFeatures {
  // Plain loops, no closures or temporary arrays: this runs for every candidate name on
  // every keystroke.
  const n = query.length;
  // Content words are the non-stopwords, or every word when all are stopwords.
  let allStop = true;
  for (const q of query) if (!QUERY_STOP.has(q)) allStop = false;
  let shown = false;
  let nMiss = 0;
  let nFuzzy = 0;
  let nExact = 0;
  const matched: number[] = [];
  for (const q of query) {
    let best = 0;
    let bestPosition = -1;
    for (let position = 0; position < seq.length; position++) {
      const l = level(q, seq[position] as string);
      if (l > best) {
        best = l;
        bestPosition = position;
      }
    }
    for (const term of extras) {
      const l = level(q, term);
      if (l > best) {
        best = l;
        bestPosition = -1;
      }
    }
    if (best === 1) nFuzzy++;
    else if (best === 3) nExact++;
    if (allStop || !QUERY_STOP.has(q)) {
      if (best > 0) shown = true;
      else nMiss++;
    }
    if (bestPosition >= 0 && !matched.includes(bestPosition)) matched.push(bestPosition);
  }
  // Leading query words equal to the name's leading words.
  let same = 0;
  while (same < n && same < seq.length && seq[same] === query[same]) same++;
  return {
    n,
    shown,
    nMiss,
    nFuzzy,
    nExact,
    exact: n === seq.length && same === n,
    prefix: n <= seq.length && same >= n - 1 && (seq[n - 1] ?? "").startsWith(query[n - 1] ?? ""),
    coverage: matched.length / Math.max(1, seq.length),
  };
}

/** Match score of one name, or null when no content word matches and it is not shown. */
export function matchScore(f: MatchFeatures, w: MatchWeights = MATCH_WEIGHTS): number | null {
  if (!f.shown) return null;
  let s = 0;
  if (f.nMiss === 0) s += w.m_all;
  s -= w.m_miss * f.nMiss;
  s -= w.m_fuzzy * f.nFuzzy;
  s += (w.m_exact * f.nExact) / f.n;
  if (f.exact) s += w.m_core_exact;
  if (f.prefix) s += w.m_prefix;
  s += w.m_coverage * f.coverage;
  return s;
}

export interface Candidate<Id> {
  id: Id;
  /** Prominence, computed at build time. */
  prominence: number;
  /** The legal name and every indexed alternative name, tokenised. */
  names: NameTokens[];
}

/** Best name match plus prominence, or null when no name matches. */
export function scoreCandidate<Id>(
  query: string[],
  candidate: Candidate<Id>,
  w: MatchWeights = MATCH_WEIGHTS,
  level: Level = matchLevel,
): number | null {
  let best: number | null = null;
  for (const name of candidate.names) {
    const m = matchScore(matchFeatures(query, name, level), w);
    if (m !== null && (best === null || m > best)) best = m;
  }
  return best === null ? null : best + candidate.prominence;
}

/** The k best candidates by score, ties broken by ascending id. */
export function topK<C extends Candidate<number | string>>(
  query: string[],
  candidates: Iterable<C>,
  k = 10,
  w: MatchWeights = MATCH_WEIGHTS,
): C[] {
  const scored: [number, C][] = [];
  const level = memoLevel();
  for (const candidate of candidates) {
    const s = scoreCandidate(query, candidate, w, level);
    if (s !== null) scored.push([s, candidate]);
  }
  scored.sort(([a, x], [b, y]) => b - a || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return scored.slice(0, k).map(([, candidate]) => candidate);
}
