/*
 * whichlei query-time ranking for the browser prototype.
 *
 * Port of research/ranking/ranking.py (fold, name_tokens, query_tokens, match_level,
 * match_features, match_score, score_candidate) with W_RECOMMENDED. Same arithmetic in the
 * same order, so scores are bit-identical to Python and ties break the same way
 * (score, then record index; records in data.js are in entity-id order).
 *
 * The static prominence P is not recomputed here: each record carries it as `p`
 * (ranking.prominence(..., W_RECOMMENDED), rounded to 2 decimals).
 *
 *   WL_RANK.fold(s)                     -> folded string (ranking.fold)
 *   WL_RANK.queryTokens(q)              -> tokens of a typed query, the last one is a prefix
 *   WL_RANK.rank(query, records, k)     -> top k of [{i, score, matched}]   (WL_RANK.W: the weights)
 *       i        index into `records`
 *       score    best name match + p
 *       matched  [[nameIndex, [[start, end], ...]], ...]  ranges in the ORIGINAL name string
 *                (name 0 = record.n, name j = record.o[j-1]); the best name comes first
 *
 * Every record is scanned (no shard routing). Names are tokenised once per records array.
 */
(function () {
  'use strict';

  // ---- Weights: match part of ranking.W_RECOMMENDED ------------------------------------
  const W = {
    m_all: 2.59,          // every content word matched
    m_miss: 4.83,         // per unmatched content word
    m_fuzzy: 1.19,        // per word matched only within one edit
    m_exact: 2.96,        // x share of query words equal to a whole name word
    m_core_exact: 0.55,   // query == name, word for word
    m_prefix: 0.84,       // query is a word-prefix of the name
    m_coverage: 2.26,     // x share of name words matched
  };
  const FUZZY_MIN_LEN = 4;   // query words shorter than this never match fuzzily
  // Optional query words: an unmatched one is not a miss, and a name that matches only
  // these words is not shown.
  const QUERY_STOP = new Set(('the of and de du des la le les der die das und et y for in ' +
    'van von di del da do a an').split(' '));

  // ---- 1. Folding ------------------------------------------------------------------------
  // NFKD does not decompose these, so they are folded explicitly first.
  const FOLD_TABLE = {
    'æ': 'ae', 'Æ': 'ae', 'ø': 'o', 'Ø': 'o', 'ß': 'ss', 'ł': 'l', 'Ł': 'l',
    'đ': 'd', 'Đ': 'd', 'ð': 'd', 'Ð': 'd', 'þ': 'th', 'Þ': 'th', 'œ': 'oe', 'Œ': 'oe',
    'ı': 'i', 'ŋ': 'n', 'ħ': 'h', 'ŧ': 't',
  };
  const FOLD_RE = /[æÆøØßłŁđĐðÐþÞœŒıŋħŧ]/g;
  const MARKS = /\p{M}/gu;
  // Python's str.split() whitespace, after NFKD has turned no-break and typographic spaces
  // into plain spaces. (Not JS \s, which also splits on U+FEFF and misses U+001C-1F, U+0085.)
  const NON_SPACE = /[^\t-\r\x1c-\x20\x85\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
  const ALNUM = /[a-z0-9]+/g;

  // ranking.py drops only characters that have a canonical combining class
  // (unicodedata.combining). Marks of class 0 (Thai, Khmer, Indic vowel signs) stay, and so
  // they do here. JS has no direct lookup, but NFD reorders marks by class: a class-0 mark
  // never moves, any other class moves past a class-1 mark that follows it or a class-240
  // mark that precedes it.
  const MARK_LOW = '\u0334', MARK_HIGH = '\u0345';   // classes 1 and 240
  function hasCombiningClass(c) {
    return (c + MARK_LOW).normalize('NFD') !== c + MARK_LOW || (MARK_HIGH + c).normalize('NFD') !== MARK_HIGH + c;
  }

  function fold(s) {
    return s.replace(FOLD_RE, (c) => FOLD_TABLE[c]).normalize('NFKD')
      .replace(MARKS, (c) => (hasCombiningClass(c) ? '' : c)).toLowerCase();
  }

  // ---- 2. Tokenisation ---------------------------------------------------------------------
  // Query: a chunk like 'h&m' or 'e.on' (all runs <= 2 chars) is one joined token,
  // 'coca-cola' stays two tokens; then adjacent single letters merge ('h','m' -> 'hm').
  function queryTokens(q) {
    const toks = [];
    for (const chunk of fold(q).match(NON_SPACE) || []) {
      const runs = chunk.match(ALNUM);
      if (!runs) continue;
      if (runs.length >= 2 && runs.every((r) => r.length <= 2)) toks.push(runs.join(''));
      else toks.push(...runs);
    }
    return mergeSingles(toks, (t) => t, (list) => list.join(''));
  }

  function mergeSingles(runs, text, join) {
    const out = [];
    let i = 0;
    while (i < runs.length) {
      if (text(runs[i]).length === 1) {
        let j = i;
        while (j < runs.length && text(runs[j]).length === 1) j++;
        out.push(join(runs.slice(i, j)));
        i = j;
      } else {
        out.push(runs[i]);
        i++;
      }
    }
    return out;
  }

  // Name tokens (ranking.name_tokens) that also remember where each character came from
  // in the original string, for highlighting. A token is {t, s, e}: its text and, per
  // character, the [s, e) range of the original character(s) it was folded from.
  //   seq    canonical token sequence ('AT&T' -> 'att', 'H & M' -> 'hm')
  //   extras the other form of a multi-run chunk ('Coca-Cola' -> 'cocacola', 'AT&T' -> 'at', 't')
  function analyze(name) {
    let folded = '';
    const from = [], to = [];
    for (let i = 0; i < name.length;) {
      const ch = String.fromCodePoint(name.codePointAt(i));
      const f = fold(ch);
      for (let u = 0; u < f.length; u++) { from.push(i); to.push(i + ch.length); }
      folded += f;
      i += ch.length;
    }
    const tok = (a, b) => ({ t: folded.slice(a, b), s: from.slice(a, b), e: to.slice(a, b) });
    const join = (list) => ({
      t: list.map((x) => x.t).join(''),
      s: [].concat(...list.map((x) => x.s)),
      e: [].concat(...list.map((x) => x.e)),
    });
    const runsAll = [], extrasAll = [];
    for (const chunk of folded.matchAll(NON_SPACE)) {
      const runs = [...chunk[0].matchAll(ALNUM)].map((m) => tok(chunk.index + m.index, chunk.index + m.index + m[0].length));
      if (!runs.length) continue;
      if (runs.length >= 2 && runs.every((r) => r.t.length <= 2)) {
        runsAll.push(join(runs));                 // 'AT&T' -> 'att', 'S.A.' -> 'sa'
        extrasAll.push(...runs);
      } else {
        runsAll.push(...runs);
        if (runs.length >= 2) extrasAll.push(join(runs));   // 'Coca-Cola' -> + 'cocacola'
      }
    }
    const seq = mergeSingles(runsAll, (x) => x.t, join);
    const inSeq = new Set(seq.map((x) => x.t));
    const seen = new Set();
    const extras = [];
    for (const x of extrasAll) {
      if (seen.has(x.t)) continue;
      seen.add(x.t);
      if (!inSeq.has(x.t) && x.t.length >= 2) extras.push(x);
    }
    return { seq, extras, words: seq.map((x) => x.t), xwords: extras.map((x) => x.t) };
  }

  // ---- 3. Match levels ---------------------------------------------------------------------
  // True if some prefix of t is within one edit (insert, delete, substitute, adjacent
  // transpose) of q. Bounded Damerau/OSA rows, as in ranking.prefix_edit_le1.
  function prefixEditLe1(q, t) {
    const n = q.length, m = t.length;
    if (m < n - 1) return false;
    // Cheap exact filter: within one edit, the first characters line up in one of five
    // ways (same, substituted, deleted, inserted, swapped). Otherwise no prefix can match.
    if (q[0] !== t[0] && q[1] !== t[1] && q[1] !== t[0] && q[0] !== t[1]) return false;
    const INF = 9;
    let prev2 = null;
    let prev = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= n; i++) {
      const cur = new Array(m + 1).fill(INF);
      cur[0] = i;
      const lo = Math.max(1, i - 1), hi = Math.min(m, i + 1);
      for (let j = lo; j <= hi; j++) {
        const cost = q[i - 1] === t[j - 1] ? 0 : 1;
        let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && q[i - 1] === t[j - 2] && q[i - 2] === t[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
        cur[j] = d;
      }
      prev2 = prev;
      prev = cur;
    }
    return Math.min(...prev.slice(Math.max(0, n - 1), Math.min(m, n + 1) + 1)) <= 1;
  }

  // 3 exact word, 2 prefix, 1 fuzzy prefix (<= 1 edit), 0 none.
  function matchLevel(q, t) {
    if (t === q) return 3;
    if (t.startsWith(q)) return 2;
    if (q.length >= FUZZY_MIN_LEN && prefixEditLe1(q, t)) return 1;
    return 0;
  }

  // ---- 4. Score one name (ranking.match_features + match_score) ---------------------------
  // Returns the match score, or null when no content word matches (name not shown).
  // Also fills `picks[i]`: the name token best matching query word i (index into seq, then
  // extras), or -1. A later token replaces an earlier one only with a strictly higher level.
  function scoreName(Q, an, picks) {
    const n = Q.length, words = an.words, xwords = an.xwords, L = words.length;
    const levels = new Array(n);
    const positions = new Set();
    for (let i = 0; i < n; i++) {
      const q = Q[i];
      let best = 0, pick = -1;
      for (let j = 0; j < L && best < 3; j++) {
        const lv = matchLevel(q, words[j]);
        if (lv > best) { best = lv; pick = j; }
      }
      for (let j = 0; j < xwords.length && best < 3; j++) {
        const lv = matchLevel(q, xwords[j]);
        if (lv > best) { best = lv; pick = L + j; }
      }
      levels[i] = best;
      if (picks) picks[i] = pick;
      if (pick >= 0 && pick < L) positions.add(pick);   // matched positions in the name
    }
    let content = [];
    for (let i = 0; i < n; i++) if (!QUERY_STOP.has(Q[i])) content.push(i);
    if (!content.length) content = Q.map((_, i) => i);
    if (!content.some((i) => levels[i] > 0)) return null;
    const nMiss = content.filter((i) => levels[i] === 0).length;
    const nFuzzy = levels.filter((lv) => lv === 1).length;
    const nExact = levels.filter((lv) => lv === 3).length;
    // Q is a token-prefix of the name, or equals it word for word
    const prefix = n <= L && Q.slice(0, n - 1).every((q, i) => words[i] === q) && words[n - 1].startsWith(Q[n - 1]);
    const exact = n === L && Q.every((q, i) => words[i] === q);
    const coverage = positions.size / Math.max(1, L);
    let s = 0.0;
    if (nMiss === 0) s += W.m_all;
    s -= W.m_miss * nMiss;
    s -= W.m_fuzzy * nFuzzy;
    s += W.m_exact * nExact / n;
    if (exact) s += W.m_core_exact;
    if (prefix) s += W.m_prefix;
    s += W.m_coverage * coverage;
    return s;
  }

  // ---- 5. Ranking --------------------------------------------------------------------------
  const analysed = new WeakMap();   // records array -> per record: [analysis of each name]

  function namesOf(rec) {
    return rec.o && rec.o.length ? [rec.n].concat(rec.o) : [rec.n];
  }

  function analysisFor(records) {
    let all = analysed.get(records);
    if (!all) {
      all = records.map((rec) => namesOf(rec).map(analyze));
      analysed.set(records, all);
    }
    return all;
  }

  // Character ranges of the query words in each shown name, merged and sorted.
  function highlights(Q, names, bestName) {
    const out = [];
    names.forEach((an, ni) => {
      if (!an.words.length) return;
      const picks = new Array(Q.length);
      if (scoreName(Q, an, picks) === null) return;
      const ranges = [];
      Q.forEach((q, i) => {
        if (picks[i] < 0) return;
        const token = picks[i] < an.seq.length ? an.seq[picks[i]] : an.extras[picks[i] - an.seq.length];
        const chars = Math.min(q.length, token.t.length);   // typed part of the word
        ranges.push([token.s[0], token.e[chars - 1]]);
      });
      ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const merged = [];
      for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
        else merged.push(r.slice());
      }
      out.push([ni, merged]);
    });
    out.sort((a, b) => (b[0] === bestName) - (a[0] === bestName) || a[0] - b[0]);
    return out;
  }

  function rank(query, records, k) {
    const Q = queryTokens(query);
    if (!Q.length) return [];
    const all = analysisFor(records);
    const hits = [];
    for (let i = 0; i < records.length; i++) {
      let best = null, bestName = 0;
      const names = all[i];
      for (let ni = 0; ni < names.length; ni++) {
        if (!names[ni].words.length) continue;
        const m = scoreName(Q, names[ni], null);
        if (m !== null && (best === null || m > best)) { best = m; bestName = ni; }
      }
      if (best !== null) hits.push({ i, score: best + records[i].p, bestName });
    }
    hits.sort((a, b) => b.score - a.score || a.i - b.i);
    return hits.slice(0, k).map((h) => ({
      i: h.i,
      score: h.score,
      matched: highlights(Q, all[h.i], h.bestName),
    }));
  }

  window.WL_RANK = { fold, queryTokens, rank, W };
})();
