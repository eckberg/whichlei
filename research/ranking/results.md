# GLEIF typeahead ranking: results

All numbers are on the **test** split unless labelled *train*. The code is in `ranking.py`, the eval method in `eval/METHOD.md`, and the full
reproduction in `run_all.sh`. CIs are 95%, from a clustered bootstrap that resamples target entities jointly across all
strata (a head item's label, aliases and typos move together; 2,000 resamples).

**Baseline B0**, used as the reference point throughout: registration status + name length + every relationship type
counted as children (capped at 60); shard files closed after 900 words, each capped at 1,500 entries.

## Recommendation
- **Packing (the largest lever).** Close each shard file before it exceeds 1,500 postings. As built, only 1.20M of
  3.43M LEIs (35%) appear in any file. With this rule, 3.32M (96.7%) do, and per-file size stays about the same (p50 37 KB).
  Hosting grows from ~56 MB to 223 MB (6,438 files).
- **Ranking:** `ranking.W_RECOMMENDED`, which is P(e) plus the match score. Prominence P(e) has 11 fitted weights plus
  **p_gov fixed at 0**; there are 7 match weights. Index legal, trading, alternative-language and transliterated names. Match
  fuzzily (1 edit). All weights are fitted jointly on train with a conditional logit.
- **Routing:** `ranking.route_budget` with `ROUTE = {min_chars 3, max_span 1, max_anchors 2}` and a debounce. At most
  2 words per query are fetched, one file each. A word's file is sticky while it is typed. Candidates ≤ 3,000 by construction.

## What changed after the independent check
1. **Government boost removed.** `p_gov` is fixed at 0 and all other weights were refitted on train.
2. **Cost-bounded routing.** It replaces merged routing and was chosen on a train-only grid (below). Cost and test quality are reported once.
3. **CIs.** They now come from the clustered bootstrap across strata; the old ones were per stratum and too narrow.
4. **Reproduction.** One command, `run_all.sh`, with no hand steps: fitted weights are written into `ranking.py` by
   `sync_weights.py`. All decisions are made on train or CV inside train: routing, name types, fuzzy matching, stripping.
5. **Bug fixed.** The JS cross-check found a name-variant dedup bug. For 1,311 entities, an alternative-language name
   identical to a previous name was dropped. Test was re-run once after the fix; no metric moved by more than 0.002.

## Test results
S@1 / S@10 / MRR@10 · *in-shard* = the target is among the fetched entries (retrieval ceiling).

| stratum (n) | B0 (baseline), as built | final ranking, as-built packing | **final (recommended)** |
|---|---|---|---|
| head label (300) | .26 / .36 / .29 · .44 | .54 / .75 / .61 · .88 | **.56 / .79 / .64** · .95 |
| head alias (253) | .28 / .32 / .29 · .34 | .80 / .87 / .82 · .90 | **.85 / .95 / .88** · .99 |
| torso (250) | .24 / .36 / .27 · .44 | .37 / .57 / .43 · .69 | **.43 / .72 / .53** · .98 |
| tail (250) | .50 / .52 / .51 · .52 | .31 / .31 / .31 · .31 | **.98 / .98 / .98** · .98 |
| typo, first 3 chars (280) | 0 / 0 / 0 · .03 | .27 / .34 / .29 · .39 | **.30 / .39 / .33** · .44 |
| typo, later (280) | .04 / .05 / .04 · .41 | .50 / .68 / .55 · .83 | **.51 / .70 / .57** · .86 |
| **objective** (mean MRR) | .233 [.210, .256] | .503 [.475, .532] | **.652 [.627, .679]** |
| objective, no governments in head strata | .233 [.209, .258] | .527 [.494, .559] | **.682 [.654, .710]** |

- Final minus B0: **+.419** [.390, .448]; without governments, +.449 [.417, .478].
- Per-shard packing is worth +.149 [.131, .168].
- Per-stratum S@1 CIs for final:

  | head label | alias | torso | tail | typo, first 3 | typo, later |
  |---|---|---|---|---|---|
  | [.50, .62] | [.80, .90] | [.37, .49] | [.95, .99] | [.25, .36] | [.45, .57] |
- Train/test gap: .663 vs .652 (no-gov .690 vs .682).
- B1, GLEIF API (100 test head labels):

  | method | S@1 | S@10 |
  |---|---|---|
  | autocompletions | .30 | .52 |
  | fuzzycompletions | .23 | .31 |
  | B0 | .30 | .39 |
  | **final** | **.56** | **.74** |
- Head label S@1 by kind: companies .63 (MRR .70), governments .38 (MRR .47). Lenient (target or its direct parent/child):
  .56 → .57. Torso: one-word queries S@1 .29, two-word .65.
- **Why the headline dropped from the previous configuration (.678 → .652):** the government boost is gone. Without
  governments, the new configuration scores .682; an independent rebuild measured .680 for the previous configuration
  on the same subset.

**Government boost.** Plugging p_gov = 2.68 into these weights raises the all-rows objective to .675 but lowers the no-government
objective to .674. It also puts a government at #1 for **57 of 1,335** company-target test queries (9 with p_gov = 0).

## Client cost (test, 1,613 queries typed one character at a time, with a file cache)
Bytes are the gzip size of the fetched files in the recommended entry format ([lei, name, country, P, alt names]).

| routing | files per query, typed (med / p90 / max) | KB (med / p90 / max) | candidates, worst keystroke (med / p90 / max) | KB without debounce (p90 / max) |
|---|---|---|---|---|
| merged (previous) | 12 / 27 / 96 | 413 / 910 / 3,280 | 3,920 / 6,637 / 26,032 | same |
| **budget (recommended)** | **2 / 3 / 6** | **65 / 106 / 230** | **2,196 / 2,904 / 3,000** | 275 / 471 |

The JS port of the scorer (`port/score.mjs`) gives the same top-10 as Python on 270/270
queries. Its time per query is median 25 ms and max 278 ms cold, ≤ 43 ms warm; the previous configuration's max was
1,458 ms. Every cost target is met with a debounce. Without a debounce, the p90 is 275 KB, 10% over target.

**Routing grid (train, weights fitted under merged routing, p_gov = 0; `logs/route_grid.log`):**

| config | obj | no-gov | typed KB p90 / max | candidates p90 / max |
|---|---|---|---|---|
| merged | .666 | .695 | 985 / 2,130 | 6,842 / 15,725 |
| 1 anchor, span 1 | .598 | .613 | 81 / 208 | 1,500 / 1,500 |
| **2 anchors, span 1, min 3 chars** | **.662** | **.690** | **107 / 239** | **2,904 / 3,000** |
| 2 anchors, span 2 | .662 | .690 | 145 / 314 | 4,119 / 5,806 |
| 2 anchors, span 3 | .664 | .691 | 194 / 520 | 5,575 / 8,500 (misses target) |
| 3 anchors, span 1 | .662 | .690 | 121 / 315 | 4,133 / 4,498 |
| 2 anchors, span 1, min 4 chars | .652 | .679 | 98 / 219 | 2,888 / 3,000 |

On train, keystroke results are identical for budget and merged routing.

## Decisions (train: 2-fold CV inside train, refitted each time; objective all / no-gov)
| option | CV objective | decision |
|---|---|---|
| recommended configuration | .657 / .684 | — |
| merged routing | .662 / .690 | no: ~9× bytes, candidates up to 26k |
| legal names only | .603 / .619 | no: alt names add +.054 |
| + previous legal names | .657 / .683 | no gain; skip |
| no fuzzy matching | .583 / .605 | no |
| + legal-form stripping | .655 / .684 | no gain; client needs no ELF list |
| + Wikidata sitelinks | .767 / .778 | optional; leaky by construction |

## Ablation (train, zeroing one weight, Δ objective [CI])

| removed | Δ objective |
|---|---|
| all prominence | −.113 [−.132, −.096] |
| registration age | −.018 [−.027, −.009] |
| consolidation children + top parent | −.018 [−.027, −.009] |
| exact-word share | −.010 [−.016, −.005] |
| name length | −.009 [−.016, −.002] |
| status | −.008 [−.011, −.004] |
| coverage | −.007 [−.013, −.001] |
| all-words bonus | −.005 [−.008, −.002] |
| fuzzy penalty | −.004 [−.006, −.002] |
| BIC | −.003 [−.007, −.000] |

ISIN, has-parent, branches, FUND, exact name and word-prefix are each within ±.002, with CIs spanning 0.

## Other measurements (test)
- **Keystrokes** (300 head labels): median 6 to top-5 and 10 to top-1; 78% of targets ever reach top-5 and 61% top-1. For companies: 6 / 9.5, 83% / 66%.
  B0 never gets there for most targets (37% / 29%).
- **Wikidata sitelinks on:** objective .768, +.115 [.097, .134]; head S@1 .56 → .87. Most of this is leakage, because head was
  selected by sitelinks; Wikidata covers 1.6% of entities.
- **Index size:**

  | configuration | total | files |
  |---|---|---|
  | initial (uniform merge, unranked) | 38 MB | 1,171 |
  | as-built packing, recommended entries | ~56 MB | 1,363 |
  | per-shard, [lei, name, country] | 199 MB | 6,438 |
  | + P per entry | 207 MB | 6,438 |
  | + alt names (recommended) | 223 MB | 6,438 |

  The routing table is 18 KB gzip plus one "capped" bit per file.

## 10 representative misses (test, final)
| query | target | outcome and reason |
|---|---|---|
| Houston | City of Houston, Texas | not in top 10: no government boost; the city has no prominence signal |
| Helsinki | Helsingin kaupunki | English label vs Finnish name; no English alternative name |
| DaimlerChrysler (alias) | Mercedes-Benz Group AG | previous names are not indexed |
| Oxf (alias) | University of Oxford | 3 letters; OXFAM ranks first |
| southern (torso) | Southern Trust Company | one-word ambiguity; THE SOUTHERN COMPANY ranks first |
| bbva (torso) | BBVA RMBS 1 FTA | the parent BBVA SA ranks first; this is eval ambiguity |
| FIRST ENGINEERING SERVICES LTD (tail) | same | every word is an oversized, capped file; never fetched |
| SAS (alias) | SAS AB | #4 behind French "… SAS" companies |
| idiana (typo) | State of Indiana | edit in the first 3 chars routes to the wrong file |
| helisnki (typo) | Helsingin kaupunki | the typo falls inside the 4-char anchor prefix |

Counts of test misses by cause are in `cache/report_test.json` (`miss_counts`).

## Recommended weights (`ranking.W_RECOMMENDED`)
P(e) = −2.90·dead −0.39·lapsed +0.32·fund +0·government +0.50·ln(1+consolidated children) +1.36·top parent
−0.56·has parent −0.91·ln(1+intl branches) +0.49·min(ln(1+ISINs), ln 51) +0.74·BIC +2.46·min(age yrs, 15)/10
−1.01·ln(name chars).

match = +2.59·all words matched −4.83·per missed word −1.19·per fuzzy-only word +2.96·exact-word share
+0.55·exact name +0.84·word-prefix of name +2.26·share of name words matched.

score = best-matching name + P.

## Open decisions
1. **Packing:** per-shard cap. Objective +.149; tail S@1 .31 → .98. Costs 223 MB vs ~56 MB hosted.
2. **Routing:** budget routing (recommended) vs merged. Merged gains +.004 on train at ~9× the bytes and up to 26k candidates.
3. **Debounce** (~150 ms) is what keeps p90 at 106 KB; without it, p90 is 275 KB.
4. **Government boost:** off. If governments matter to your users, measure them with a non-Wikidata sample first.
5. **Wikidata signal:** +.115, but leaky, and needs a refresh pipeline.
6. **Alternative names:** +.054 CV objective for +28 MB (195 → 223 MB: extra postings plus the name strings).
7. **FUND weight:** +0.32 with no measurable effect; its sign is a product call.

## Known gaps and uncertainty
- **Acronyms:** "seb" → SEB SA (cookware), not Skandinaviska Enskilda Banken.
- **"vanguard":** The Vanguard Group is #2, behind a Vanguard fund (it was #5 in the previous configuration).
- **CJK/Cyrillic:** ~92k legal names have no Latin token and no Latin alternative name.
- **Typos:** edits in the first 3–4 characters land in the wrong file.
- **Previous names** are not searchable.
- **Status penalties** cannot be measured, because every eval target is active.
- **Eval caveats:** head is 28% governments and 15% of head labels are lexically unanswerable; Wikidata truth is sometimes a
  subsidiary; typos are synthetic; B1 has 100 queries.

## Reproduce
`SKIP_B1=1 ./run_all.sh` takes about 40 minutes on 4 cores; drop `SKIP_B1=1` to re-query the GLEIF API, which adds ~4 minutes. It
rebuilds the caches, fits, routing grid, train report, self-test, test report and JS timing, using the committed
`eval/*.tsv` (rebuilding those from signals + Wikidata is a separate, optional step; see the README). Per-step logs are in
`logs/`, numbers in `cache/report_{train,test}.json`. Seeds:

| item | seed |
|---|---|
| eval set | 20260927 (+1…4 per stratum) |
| B1 sample | +10 |
| CV folds | sha1("cv:"+LEI) mod 2 |
| bootstrap | 7 |
| self-test | 1 |

## Independent check
A second, independently written index build and JavaScript scorer checked this study. Confirmed: packing and
reachability, byte-identical reproduction, no weight or λ fit on test, government counts (9 vs 57 of 1,335), identical
routing in Python and JS for all 1,613 test sessions, and objective 0.652. A clean `run_all.sh` reproduces all of it
(`final.json == ranking.W_RECOMMENDED`, self-test 300/300).

It corrected the client cost figures above:
- The cost table assumes the debounce fires only on the last key. At phone typing speed a
  150 ms debounce fires on most keys. Firing on every key: files 4 / 8 / 13, bytes
  147 / 271 / 462 KB (median / p90 / max).
- Scoring time for the slowest keystroke per query: 20 / 43 / 476 ms in JS on an idle
  server. The 278 ms figure covered only the final keystroke. Phones are several times slower.
- The test split was scored more than once while fixing bugs, so test numbers may be
  slightly optimistic.

Hand check, 20 queries: the right entity is first for 19; "seb" still finds SEB SA.
Weaker than the previous configuration at rank 2–3 on a few short queries: "total" no longer reaches
TotalEnergies, "sas" misses SAS AB, "bp" ranks BPCE above BP.
