# 02 · Core

Status: done

## Goal
The search logic exists in TypeScript: normalisation, tokeniser, scorer and identifier
checks, the same code for the indexer and the browser. It gives the same answers as the
Python reference in `research/ranking/ranking.py`, so the ranking results carry over.

## Scope
In `packages/core`:
- `fold`: the explicit fold table, NFKD, drop combining marks, lower case.
- `nameTokens`, `queryTokens`, `indexTerms`.
- The scorer: match levels (exact, prefix, one-edit fuzzy prefix), match features,
  `scoreCandidate` (best name match + prominence), `topK`, and the fitted match weights.
- Identifier checks: LEI (done in slice 1), ISIN (ISO 6166 check digit), BIC (ISO 9362
  shape and country code), and `identifierReadings`, which lists every reading an input has.
- Fixtures generated from the Python reference, checked in CI.
- A parity script that compares against the reference on the full corpus, run by hand.

## Not in scope
- Prominence (slice 5, it needs GLEIF attributes), routing and file format (slice 4).
- Legal-form stripping: off in the reference, measured as no gain.
- Register numbers: no check digits to test; slice 8 resolves them by lookup.

## Approach
Port `ranking.py` function by function; `research/ranking/port/score.mjs` is a starting
point. Python's whitespace set is matched explicitly, since JavaScript's `\s` differs.
`research/ranking/port/dump_core_fixture.py` writes the CI fixtures using only
`ranking.py`: tokens for every name and query in the evaluation set plus edge cases, match
scores bit for bit, and the top 10 for every 8th evaluation query against a fixed pool of
the evaluation entities.
The full-scale check uses the reference's own candidates and prominence for every
evaluation query; that data is too large to commit.

## Unknowns
- Python 3.11 has Unicode 14, Node 26 a newer version, and JavaScript has no
  "combining class" property. The full-corpus comparison shows whether that changes any
  token. Any difference is either fixed or listed here with the reason it is accepted.
  Result: identical tokens for all 3,742,453 names in the corpus. Tried on every code point,
  2,499 give different tokens. They are accepted: none occurs in GLEIF's names, and from
  now on this port, not the Python, is the reference. The classes:
  - 2,118 nonspacing marks with combining class 0, which Python keeps and the port drops.
  - 50 spacing marks with a combining class, which Python drops and the port keeps.
  - 331 code points unassigned in Unicode 14, and 37 with newer NFKD mappings.
  Browsers ship different Unicode versions too; slice 7 checks the query side.

## Done when
- Tokens equal the reference for every name the index uses (golden copy 2026-09-16).
  Evidence: the parity script's count, 0 differences.
- The top 10 equals the reference for every evaluation query on the reference's
  candidates. Evidence: the parity script's count, 0 differences.
- Every ISIN and BIC in GLEIF's mapping files passes its check. Evidence: counts.
- CI passes with the fixture tests.
