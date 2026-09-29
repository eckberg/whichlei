# whichlei plan

Built in slices, in order. Each slice gets a spec in `docs/specs/` before work starts, and
is done when its condition is shown, not claimed.

The risky parts come first: whether the full index builds within free CI limits, and
whether search stays instant on a phone. Deployment comes early, so every later slice can
be tried on a real URL and a real phone.

| # | Slice | Done when |
|---|-------|-----------|
| 1 | Workspace | A pnpm workspace with TypeScript, lint and tests; CI runs on every pull request. |
| 2 | Core | Normalisation, tokeniser, scorer and input checks in TypeScript. Same tokens as the reference for every name in the corpus; same top 10 for every evaluation query. |
| 3 | Skeleton on Cloudflare | The prototype, served by a Worker on a workers.dev URL, searching the sample index. Deployed by a manually triggered workflow. |
| 4 | Index format | The file format is fixed by measurement on the full corpus: bytes fetched per query, and the slowest keystroke on a mid-range phone. |
| 5 | Indexer | Builds the full index from GLEIF's files on a GitHub-hosted runner. Reachability, sizes and evaluation scores match `research/ranking`. |
| 6 | Data publishing | A scheduled workflow builds, checks and publishes the index. A failed check publishes nothing, and the previous index can be restored. |
| 7 | Search | The production search page: keyboard flows, screen readers, both themes. End-to-end tests pass; the targets from slice 4 are met. |
| 8 | Lookups and records | LEIs, ISINs, BICs and register numbers resolve live through the GLEIF API. The record view shows source, date and copy actions. |
| 9 | Record pages | `/lei/<code>` is rendered by a Worker, cached, readable without JavaScript and indexable. |
| 10 | Ranking gaps | Acronyms and short queries improve on the evaluation set, with no regressions. |
| 11 | Launch | Live on whichlei.com with analytics, README and about page. No cookies set, checked in a browser. |

## Hosting

- **Site:** a Worker with static assets, deployed by hand from GitHub Actions.
- **Index:** a second Worker holding only static assets, published by the scheduled data
  workflow. Static requests are free and unlimited. A publish replaces every file at once,
  a rollback restores the previous version, and the site never redeploys for new data.
- **Build:** GitHub-hosted runners (4 vCPU, 16 GB RAM, 14 GB disk, 6 h per job), free for
  public repositories.

## Risks

- Scheduled workflows in a public repository stop after 60 days without repository
  activity. Slice 6 needs a way to keep the schedule alive.
- Record pages are rendered by a Worker, so crawlers spend the account's included Worker
  requests. Slice 9 sets cache lifetimes and measures the draw.
- The slowest keystroke took up to 476 ms on a server CPU. Phones are slower. Slice 4
  sets the target, slice 7 meets it.

## Not planned

- Accounts, watchlists, alerts, monetization: see DESIGN.md non-goals.
- Names with no Latin-script form, until after launch.
