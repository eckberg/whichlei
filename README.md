# whichlei

Which LEI does this entity have? Type a name, an LEI, an ISIN, a BIC or a national register
number and get the Legal Entity Identifier while you type. Copy it and leave.

Live at **[whichlei.com](https://whichlei.com)**. Free, with no account and no cookies.
Analytics are [Fathom](https://usefathom.com): page views and a count of searches, never what
you typed.

## Data

Every record comes from [GLEIF](https://www.gleif.org), the Global Legal Entity Identifier
Foundation, which publishes it under [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
The search index is built daily from the
[golden copy](https://www.gleif.org/en/lei-data/gleif-golden-copy/download-the-golden-copy/).
An opened record is fetched live from the GLEIF API and shows its source and date.

whichlei is not affiliated with GLEIF.

## Develop

Node and pnpm versions are in `.node-version` and `package.json`.

```
pnpm install --frozen-lockfile
pnpm dev          # the site on http://localhost:8787
pnpm lint         # Biome: lint and format check (pnpm format applies fixes)
pnpm typecheck
pnpm test         # Vitest
pnpm e2e          # Playwright, against a local site and a fixture index
```

`pnpm dev` builds the site without an index, so the search box says so. To search, build with
one: `INDEX_ORIGIN=https://index.whichlei.com pnpm --filter @whichlei/web build` and then
`pnpm --filter @whichlei/web dev`. `pnpm e2e` needs Chromium (`pnpm --filter @whichlei/web
exec playwright install chromium`) and serves its own small index.

## More

- [DESIGN.md](DESIGN.md): what this is, and the decisions behind it.
- [docs/specs](docs/specs/): one spec per build slice.
- [research/ranking](research/ranking/): how results are ranked, and the evidence.

Licence: [MIT](LICENSE).
