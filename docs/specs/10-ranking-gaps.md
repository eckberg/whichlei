# 10 · Ranking gaps

Status: done

## Goal
An acronym finds the entity it stands for ("ibm" → International Business Machines
Corporation, "aig", "rbc", "swift"), and a short name finds the entity it is the whole
name of ("bp" → BP P.L.C., not BPCE), with no stratum of the evaluation set worse than
before.

## Scope
- A set of 60 well-known acronyms and short names with verified targets, apart from the
  evaluation set: `research/ranking/eval/acronyms.tsv`, written by `build_acronyms.py`,
  which checks each LEI against the golden copy and records how (`verified` column). Of
  the 79 it lists, 19 whose entity is also a target of the evaluation set ("ibm", "bmw",
  "bp", "sas", "hsbc", "h&m" …) are left out, so the two sets share no entity.
- `tools/bench`: `gaps.ts` (replay a built index: per stratum, per subset, rank and cause
  per query, index size, bytes per query), `fit.ts` (choose the new weights on train; it
  prints nothing of the test half), `compare.ts` (before against after, with a clustered
  bootstrap).
- `packages/core`: `LEGAL_FORMS`, `formStart`, `nameInitials`; two match features with their
  own weights. `REFERENCE_MATCH_WEIGHTS` is the reference with both at 0; the parity tests
  and `parity.ts` use it.
- `apps/indexer`: entities with prominence ≥ 1 also index the initials of their names
  (`--initials-min-prominence`; `Infinity` builds the research's index). The scorer
  applies the same test (`INITIALS_MIN_PROMINENCE`, on the prominence the file stores),
  so a result does not depend on which file an entity was fetched from.

## Not in scope
- The 19 reference weights: not refitted. Typos in the first characters, previous names,
  names without a Latin form. Routing. The index format stays version 1.

## Measured before
Built from the 2026-09-16 golden copy (`research/data`), replayed as `check --eval` does.
Subsets: the acronym set (60; 30 test), and the evaluation set's short queries, one word of
2 to 4 characters outside the typo strata (144; 58 test: 29 head, 29 torso).

- **Acronym set**: 36 first. All 22 queries that are a name's initials, or their start
  ("seb", "aig", "rbc"), fail as **not a candidate**: no index term equals the acronym, so
  the entity is in no fetched file. Of the 38 that are a word of the name, 2 **score low**: "sca" behind
  French "… SCA" companies, "pnc" behind its own bank. In the evaluation set, "bp" ranks
  behind BPCE (a prefix match with prominence 8.6 against 5.9), and "sas" behind French
  "… SAS" companies.
- **Short queries**: 37 of 144 first (both halves). 97 score low, mostly one-word torso
  queries, ambiguous by construction (METHOD.md), and city names; 10 are not candidates, 8
  of them acronyms (BMW, IBM, KLM, AMD, HBO, WWE, PBS, TSMC).
- Routing was never the cause: every subset query routes on a pause, which is how the
  evaluation scores the final query.

## Approach
1. **Initials as index terms.** `nameInitials`: the first letter of each word, stop words
   out, trailing legal form out (`LEGAL_FORMS`, the frequent last words of legal names that
   are legal forms); a second variant keeps the legal form's first word when it is spelled
   out ("corporation": BBC, HSBC). Three to six words, each starting with a letter. The
   indexer adds them as terms for entities whose stored prominence is ≥ 1 (10,977 entities
   gain a term). The browser computes the same initials from the names in the file: no
   format change.
2. **`m_initials` = 6.5**: a name that the one-word query equals the initials of scores 6.5
   (plus prominence), when that beats its word match, for a candidate with prominence ≥ 1.
   0 turns it off, and the initials are then not looked at.
3. **`m_base_exact` = 1**: the query equals the name less its trailing legal form ("bp" for
   BP P.L.C.).

Weights by grid on the train half, the 19 reference weights fixed, maximising mean MRR@10
over the six strata and the acronym set's train half. Index options by the same criterion,
then by cost. First round, with the 79-query set (39 train) and no prominence test in the
scorer:

| Option (train) | Objective | Criterion: six strata and acronym set | Files |
|---|---|---|---|
| Reference | .6629 | .6616 | 6,438 |
| **Initials, ≥ 3 letters, prominence ≥ 1 (chosen)** | **.6663** | **.6920** | **6,445** |
| prominence ≥ 0.2 | .6663 | .6920 | 6,457 |
| prominence ≥ 2 | .6660 | .6917 | 6,439 |
| prominence ≥ −0.5 | .6656 | .6935 | 6,516 |
| 2-letter initials too, ≥ 0.2 | .6663 | .6920 | 6,477; 572 fewer entities reachable |
| `m_initials` alone / `m_base_exact` alone | .6641 / .6649 | .6901 / .6633 | |

Second round, after review: the 60-query set (30 train) and the prominence test in the
scorer. The grid chose the same weights, 6.5 and 1.

| Option (train) | Objective | Criterion | Files |
|---|---|---|---|
| Reference | .6629 | .6658 | 6,438 |
| **Chosen, as above** | **.6663** | **.6949** | **6,445** |
| No initials for funds (8,228 entities instead of 10,977) | .6664 | .6950 | 6,442 |
| Hyphenated words as one ("DWS-Fonds BPT" → "db", not "dfb") | .6663 | .6949 | 6,445 |
| Both | .6664 | .6950 | 6,442 |

Rejected:
- **A penalty for matching only a legal form** ("sas" in "Akuo Energy SAS"): no change on
  train at any weight from 0 to 1.5, worse at 2. Dropped; "sas" and "sca" stay second.
- **Two-letter initials**: no gain on train. Against three letters at the same threshold they
  cap 11 more files (779 against 768) and push 565 more entities out of the index.
- **Abbreviated legal forms in the initials**: "Koninklijke Philips N.V." became "kpn" and
  beat KPN. Only a spelled-out form counts.
- **No initials for funds** (a quarter of the holders): one torso query on train (+.0001),
  within noise. And the scorer cannot apply it: an index line has no category, so a fund
  fetched through another word would still match by its initials.
- **Hyphenated words as one word**: no change on train.
- **Routing a short word while typing**, not only on a pause: the evaluation scores the
  paused query, so it cannot show a gain, and every two-letter prefix would fetch a file.

## Results
Held-out half, MRR@10, after − before with a 95% interval (clustered bootstrap, target
entities resampled across strata, 2,000 times, seed 7). Noise: the interval on the
objective is about ±.003, on one stratum up to ±.013.

| Test | n | Before | After | Δ [95%] |
|---|---|---|---|---|
| Objective | 1,613 | .6515 | .6537 | +.0022 [−.0009, .0049] |
| Head label | 300 | .6334 | .6429 | +.0096 [−.0032, .0224] |
| Head alias | 253 | .8781 | .8785 | +.0004 [−.0018, .0016] |
| Torso | 250 | .5264 | .5295 | +.0032 [−.0048, .0143] |
| Tail, typo first 3, typo later | 250, 280, 280 | .9760, .3264, .5689 | same | 0 |
| Acronym set | 30 | .5500 | .7900 | +.2400 [.0606, .5800] |
| Short queries | 58 | .3635 | .3793 | +.0158 [−.0244, .0489] |
| of which head | 29 | .491 | .542 | |
| of which torso | 29 | .236 | .217 | |

The objective's gain on test, +.0022 [−.0009, .0049], is within noise: the real gain is
the acronym set. S@1, test: acronym set .533 → .733; short queries .259 → .293 (head
.379 → .448, torso .138 → .138); head label .557 → .570. Train: objective .6629 → .6663
[.0002, .0065], acronym set .683 → .867, short queries .325 → .371. No stratum is lower on test; on train
tail −.0007 and typo later −.0024, within their intervals. The short queries gain on test
is within noise: the torso half is one-word queries for a random holder of an ISIN or a
child, ambiguous by construction (METHOD.md), and moves down slightly; the head half,
named entities, moves up. Of the 300 + 253 head queries on test, 8 rose ("bp", "amd",
"swift", "xerox", "sas" …) and 6 fell ("aston martin lagonda" 1 → 2, "mons" 3 → 7, "dfb"
5 → 8, "vaasa", "augusta", "southwest" by one or more places).

Index (gzip level 6) and bytes per test query, typed one key at a time (median / p90 /
max): files 6,438 → 6,445 (+0.1%), entries 7,495,588 → 7,506,529 (+0.15%), 220.61 →
220.98 MB (+0.17%), reachable entities 3,317,220 → 3,317,217. Debounce on every key
147.9 / 271.8 / 463.1 → 148.1 / 271.9 / 465.2 KB; on the last key 63.9 / 105.2 / 224.7 →
63.9 / 105.3 / 224.9 KB.

Still not first in the acronym set (13 of 60): "seb" (SEB SA, the French group, is more
prominent and named exactly that); "tcs" (prominence under 1); "edf" ("de" is a stop
word); "anz", "iag", "pko", "bny" (not the legal name's initials); "ge" (two letters);
"sbi" 5th, "bat", "sca", "tsb" (behind the shell "TSB, L.P.", by `m_base_exact`) and
"pnc" 2nd. Left out with the overlap, and also not first: "klm", "hbo" (prominence under
1), "gm", "db", "sg" (two letters), "sas".

## Unknowns
- The acronym set is small and hand-picked, and its test half was looked at while
  designing the features (legal forms, the spelled-out variant). Only the weights and
  options were chosen on train alone.
- Scoring time in the browser. Slice 7's bench (`pnpm --filter @whichlei/bench search
  --rate 4 --every 16 --page-every 16 --last-every 16 --modes last --skip bytes`), one
  locked session, core of origin/main (A) against this slice (C), slowest keystroke per
  query at 4x, debounce on the last key, median / p90: `Search` A 75.9 / 121, 72.7 / 125,
  72.8 / 134 ms and C 79.3 / 120, 74.6 / 127 ms; the page, key to final results, slowest
  per query, A 259 / 356, 255 / 336, 274 / 359 ms and C 265 / 349, 275 / 377 ms. No
  difference above noise. A first version, which cached a shape per name in a WeakMap
  and built every name's initials, was 94 / 142 ms: the initials are now tried only for
  a name whose first word starts with the query's letter.

## Done when
- The acronym set improves on test beyond noise (+.24, interval [.06, .58]); the short
  queries improve within noise (+.016), their named half by +.05; no stratum of the
  objective falls: the table above (`compare.ts`).
- Index size and bytes per query within a few percent: +0.16% and +0.1% (median).
- With both new weights at 0 the scorer is the reference's: `reference.test.ts` and
  `parity.ts` use `REFERENCE_MATCH_WEIGHTS` and pass; `parity.ts` at full scale: name
  tokens 3,742,453 / 3,742,453 and top 10 3,229 / 3,229 identical.
- The indexer's own replay agrees: `check --eval` on the new build, objective .6537 test,
  .6598 all (before: .6515, .6570); the same inputs give the same build id twice.
- `pnpm lint && pnpm typecheck && pnpm test` pass; new tests in `initials.test.ts` (with
  the prominence test in the scorer) and `build.test.ts`.

## Re-run
```
python3 research/ranking/build_acronyms.py                       # DATA_DIR as in CLAUDE.md
pnpm --filter @whichlei/indexer build --input-dir $DATA_DIR --out new
pnpm --filter @whichlei/indexer build --input-dir $DATA_DIR --out old --initials-min-prominence Infinity
node tools/bench/scripts/fit.ts --index new                      # weights on train
node tools/bench/scripts/gaps.ts --index new --out after.json
node tools/bench/scripts/gaps.ts --index old --out before.json --weights zero.json
node tools/bench/scripts/compare.ts before.json after.json       # zero.json: both new weights 0
```
