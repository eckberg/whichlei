// Query-time scoring. Port of research/ranking/ranking.py, section 4, with legal-form
// stripping off (the recommended configuration), so the core name is the whole name.
import { formStart, INITIALS_LENGTH, type NameTokens, nameInitials } from "./tokens.ts";

/**
 * The match weights of the reference (ranking.py W_RECOMMENDED), fitted there, with the
 * slice 10 features off (0): this scores exactly as the reference does. The prominence
 * weights come with the indexer.
 */
export const REFERENCE_MATCH_WEIGHTS = {
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
  /**
   * Score of a name the query matches as its initials ('seb' for Skandinaviska Enskilda
   * Banken AB), when that beats its word match. 0: initials never match.
   */
  m_initials: 0,
  /** Query equals the name without its trailing legal form ('bp' for BP P.L.C.). */
  m_base_exact: 0,
} as const;

export type MatchWeights = Record<keyof typeof REFERENCE_MATCH_WEIGHTS, number>;

/**
 * The weights search uses: the reference's, plus the slice 10 weights, chosen on the
 * evaluation set's train half (docs/specs/10-ranking-gaps.md).
 */
export const MATCH_WEIGHTS: MatchWeights = {
  ...REFERENCE_MATCH_WEIGHTS,
  m_initials: 6.5,
  m_base_exact: 1,
};

/**
 * Entities at least this prominent, as an index file stores it (in tenths), index the
 * initials of their names, and only they match by initials: about the top 30,000. The
 * indexer and the scorer apply the same test, so a result does not depend on which file
 * an entity was fetched from (docs/specs/10-ranking-gaps.md).
 */
export const INITIALS_MIN_PROMINENCE = 1;

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
  /** The query is one word, equal to the name's initials. */
  initials: boolean;
  /** The query equals the name without its trailing legal form, and the name has one. */
  baseExact: boolean;
}

/**
 * Whether the query is one word that equals the initials of the name. Most names fail on
 * the first letter, before any initials are made: this runs for every candidate name.
 */
function isInitials(query: readonly string[], seq: readonly string[]): boolean {
  const q = query[0];
  if (query.length !== 1 || q === undefined) return false;
  if (q.length < INITIALS_LENGTH.min || q.length > INITIALS_LENGTH.max) return false;
  let first = 0;
  while (first < seq.length && QUERY_STOP.has(seq[first] as string)) first++;
  if ((seq[first] ?? "").charCodeAt(0) !== q.charCodeAt(0)) return false;
  return nameInitials(seq, QUERY_STOP).includes(q);
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

/**
 * Features of one name against the query tokens. The last query token may be partial.
 * `initials`: whether the name may match as initials at all (scoreCandidate passes false
 * below INITIALS_MIN_PROMINENCE and when m_initials is 0).
 */
export function matchFeatures(
  query: string[],
  { seq, extras }: NameTokens,
  level: Level = matchLevel,
  initials = true,
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
    initials: initials && isInitials(query, seq),
    // The query is the name's leading words, and the rest is its legal form.
    baseExact: same === n && n < seq.length && formStart(seq) === n,
  };
}

/**
 * Match score of one name, or null when it is not shown: no content word matches and the
 * query is not its initials (or m_initials is 0). With the slice 10 weights at 0 this is
 * the reference's score, bit for bit.
 */
export function matchScore(f: MatchFeatures, w: MatchWeights = MATCH_WEIGHTS): number | null {
  const initials = f.initials && w.m_initials !== 0 ? w.m_initials : null;
  if (!f.shown) return initials;
  let s = 0;
  if (f.nMiss === 0) s += w.m_all;
  s -= w.m_miss * f.nMiss;
  s -= w.m_fuzzy * f.nFuzzy;
  s += (w.m_exact * f.nExact) / f.n;
  if (f.exact) s += w.m_core_exact;
  if (f.prefix) s += w.m_prefix;
  s += w.m_coverage * f.coverage;
  if (f.baseExact) s += w.m_base_exact;
  return initials !== null && initials > s ? initials : s;
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
  const initials = w.m_initials !== 0 && candidate.prominence >= INITIALS_MIN_PROMINENCE;
  for (const name of candidate.names) {
    const m = matchScore(matchFeatures(query, name, level, initials), w);
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
