# whichlei plan

Built in vertical slices, in order. Each slice gets a spec in `docs/specs/` before work
starts, and is done when its condition is shown, not claimed.

| # | Slice | Done when |
|---|-------|-----------|
| 0 | Walking skeleton | An empty app builds and deploys to a real URL through CI. |
| 1 | Index pipeline | A nightly job builds the files, routing table and prominence scores; size and reachability match DESIGN.md §3. |
| 2 | Typeahead | Typing searches the real index. Top 10 matches the reference ranking on the evaluation set; bytes and slowest-keystroke time measured on a phone. |
| 3 | Input routing | Names, LEIs, ISINs, BICs and register numbers route correctly; check digits validated locally. |
| 4 | Record view | An opened record loads live from GLEIF, with source date and copy actions. |
| 5 | Record pages | `/lei/<code>` is readable without JavaScript and indexable. |
| 6 | Ranking gaps | Acronyms, short queries, non-Latin names and early typos improve on the evaluation set without regressing the rest. |
