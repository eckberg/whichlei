# Evaluation set: method

Built by `build_eval.py` (seed `SEED = 20260927`; sub-seeds
SEED+1 to SEED+4 per stratum). The builder uses only raw data (entities, Wikidata, ELF list)
and a frozen copy of the tokenizer as it was when the set was built. It uses no prominence
signal and no scorer weight. Re-running it reproduces these files byte for byte (checked).

Files: `head.tsv`, `torso.tsv`, `tail.tsv`, `typo.tsv`. Columns:
`query, target_lei, stratum, split, qtype, alt_leis, entity_name, qid, sitelinks`.
A hit on `target_lei` or on any `alt_leis` counts as correct.

## Strata

| stratum | how it is built | size |
|---|---|---|
| head (label) | Wikidata items whose LEI is in the corpus with entity status ACTIVE. Each LEI goes to its highest-sitelink item. Items are ranked by sitelinks and the top 600 are kept, skipping items with an empty or code-like English label (14 were skipped, all with an empty label). Query = English label. Truth = every ACTIVE LEI the item lists; the primary target is the one whose legal name shares the most tokens with the label. | 600 queries (min 50 sitelinks) |
| head (alias) | English aliases of the same items. Dropped: code-like aliases (ISO 3166-2, tickers, LEI/ISIN, "Fla.") and aliases of 2 chars or fewer (111); aliases that are *unanswerable* by any name-based search, i.e. some alias token is not a prefix of any token in the target's legal, other or transliterated GLEIF names (1,040, e.g. "Tinsel Town", "Big Blue"). At most 3 per item, sampled with a seed (21 dropped). | 537 queries |
| torso | Random ACTIVE entities **not in Wikidata** that have at least one child (any relationship type), an ISIN, or a BIC. Pool: 160,994. Query = the first 1 or 2 (seeded coin flip) *distinctive* words of the legal name. A word is non-distinctive if it is an ELF abbreviation token, a single-word ELF local name, a stopword or a generic legal-form word (list in the code), or is only digits. 11 entities had no distinctive word and were skipped. | 500 (294 one-word, 206 two-word) |
| tail | Random entities with registration status ISSUED, **not in Wikidata**, whose normalized legal name (token sequence) is unique in the corpus. Pool: 1,839,778. Query = full legal name, as written. | 500 |
| typo | Every head label with ≥5 alphanumeric characters, twice: one edit at a position in the first 3 characters (`typo_first3`) and one at a later position (`typo_later`). The edit is delete, substitute (random a–z) or adjacent transpose, chosen by seed. Applied to the folded, lowercased label. | 554 + 554 |
| keystrokes | Not a file: the head label queries are replayed one character at a time (see `report.py`). | test half of head labels |

## Split

Every stratum is split exactly 50/50 **by entity**: entities are sorted by
`sha1("20260927:" + LEI)` and the first half is `train`. A head item's label, aliases,
typos and keystroke replays share their entity's split. All weights are fitted on
`train` only; `results.md` reports `test`.

## Composition and known biases

- **Head is 28% government.** Of the 600 head labels, 432 are GENERAL, 158
  RESIDENT_GOVERNMENT_ENTITY and 8 INTERNATIONAL_ORGANIZATION. Top Wikidata items by
  sitelinks are cities, US states and countries ("Berlin", "Florida", "Latvia").
  Results are also reported separately for companies and governments.
- **15.5% of head labels are lexically unanswerable** (507/600 answerable). The English
  label does not prefix-match any GLEIF name ("Prague" vs "HLAVNÍ MĚSTO PRAHA",
  "Helsinki" vs "Helsingin kaupunki"). These are kept, so head S@1 cannot reach 1.0.
- **Torso targets are often one of many same-named siblings.** A random ISIN holder is
  often a fund ("lazard" → "LAZARD ACTIONS EMERGENTES", not "LAZARD, INC."). One-word
  torso queries are therefore partly ambiguous by construction. That caps torso scores for
  every method and rewards "fund-friendly" prominence (the fitted `p_fund` is small).
- **Every target is ACTIVE or ISSUED** (torso: 381 ISSUED, 119 LAPSED). The eval cannot
  reward finding inactive entities, so status penalties look free. They are not free
  for users looking up dissolved companies.
- **Leakage.** Head truth comes from Wikidata, so using Wikidata sitelinks as a
  prominence feature inflates head by construction. It is reported on/off and is off
  in the recommended configuration. Torso and tail exclude every LEI that appears in
  Wikidata. Aliases were filtered with GLEIF names (answerability). That filter is
  equally generous to every method, including B0 and B1.
- **Tail excludes names with no Latin tokens** (135,279 corpus names, 3.9%, mostly CJK and
  Cyrillic legal names without a transliteration). They normalize to the empty string,
  so they are never "unique". Their searchability is a separate gap, not measured here.
- Typos are synthetic and uniform over positions and edit types, not a model of real
  typing errors.

## Metrics

Success@1/5/10 and MRR@10 per stratum; `inshard` is the retrieval ceiling: the share of
queries whose target is among the entries of the fetched shard file(s) after the per-file
cap. Head also gets a lenient S@1/S@10 that accepts the target's direct parent or
direct child (ACTIVE IS_DIRECTLY_CONSOLIDATED_BY pairs).
