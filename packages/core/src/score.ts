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
const QUERY_STOP = new Set(
  "the of and de du des la le les der die das und et y for in van von di del da do a an".split(" "),
);

/**
 * True if some prefix of `term` is within one edit (insert, delete, substitute, adjacent
 * transpose) of `query`. Optimal string alignment, only the band that can stay within 1.
 */
export function prefixEditLe1(query: string, term: string): boolean {
  const n = query.length;
  const m = term.length;
  if (m < n - 1) return false;
  const INF = 9;
  let prev2: number[] = [];
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i, ...Array<number>(m).fill(INF)];
    for (let j = Math.max(1, i - 1); j <= Math.min(m, i + 1); j++) {
      const cost = query[i - 1] === term[j - 1] ? 0 : 1;
      let d = Math.min((prev[j] ?? INF) + 1, (cur[j - 1] ?? INF) + 1, (prev[j - 1] ?? INF) + cost);
      if (i > 1 && j > 1 && query[i - 1] === term[j - 2] && query[i - 2] === term[j - 1]) {
        d = Math.min(d, (prev2[j - 2] ?? INF) + 1);
      }
      cur[j] = d;
    }
    prev2 = prev;
    prev = cur;
  }
  // The query is fully consumed; any prefix of the term may remain.
  return Math.min(...prev.slice(Math.max(0, n - 1), Math.min(m, n + 1) + 1)) <= 1;
}

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

/** Features of one name against the query tokens. The last query token may be partial. */
export function matchFeatures(query: string[], { seq, extras }: NameTokens): MatchFeatures {
  const n = query.length;
  const levels: number[] = [];
  const matched = new Set<number>();
  for (const q of query) {
    let best = 0;
    let bestPosition = -1;
    seq.forEach((term, position) => {
      const level = matchLevel(q, term);
      if (level > best) {
        best = level;
        bestPosition = position;
      }
    });
    for (const term of extras) {
      const level = matchLevel(q, term);
      if (level > best) {
        best = level;
        bestPosition = -1;
      }
    }
    levels.push(best);
    if (bestPosition >= 0) matched.add(bestPosition);
  }
  const sameUpTo = (count: number) => query.slice(0, count).every((q, i) => seq[i] === q);
  const stopFree = query.flatMap((q, i) => (QUERY_STOP.has(q) ? [] : [i]));
  const content = stopFree.length > 0 ? stopFree : query.map((_, i) => i);
  return {
    n,
    shown: content.some((i) => (levels[i] ?? 0) > 0),
    nMiss: content.filter((i) => levels[i] === 0).length,
    nFuzzy: levels.filter((level) => level === 1).length,
    nExact: levels.filter((level) => level === 3).length,
    exact: n === seq.length && sameUpTo(n),
    prefix: n <= seq.length && sameUpTo(n - 1) && (seq[n - 1] ?? "").startsWith(query[n - 1] ?? ""),
    coverage: matched.size / Math.max(1, seq.length),
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
): number | null {
  let best: number | null = null;
  for (const name of candidate.names) {
    const m = matchScore(matchFeatures(query, name), w);
    if (m !== null && (best === null || m > best)) best = m;
  }
  return best === null ? null : best + candidate.prominence;
}

/** The k best candidates by score, ties broken by ascending id. */
export function topK<Id extends number | string>(
  query: string[],
  candidates: Iterable<Candidate<Id>>,
  k = 10,
  w: MatchWeights = MATCH_WEIGHTS,
): Candidate<Id>[] {
  const scored: [number, Candidate<Id>][] = [];
  for (const candidate of candidates) {
    const s = scoreCandidate(query, candidate, w);
    if (s !== null) scored.push([s, candidate]);
  }
  scored.sort(([a, x], [b, y]) => b - a || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return scored.slice(0, k).map(([, candidate]) => candidate);
}
