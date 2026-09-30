# 06 · Data publishing

Status: approved

## Goal
Every night the index is rebuilt from GLEIF's latest golden copy, checked, and published,
with no one watching. A build that fails a check publishes nothing, and the previous index
can be restored with one run.

## Scope
- `apps/index`: the assets-only Worker `whichlei-index` on workers.dev. Headers: CORS for
  any origin, `nosniff`, `index.json` revalidated on every load, build files immutable for a
  year (docs/index-format.md).
- `.github/workflows/publish-index.yml`, daily at 02:47 UTC and by hand: build the latest
  golden copy (GLEIF publishes at 00:00, 08:00 and 16:00 UTC), run the checks, add the
  live build's files so open pages keep working, deploy, and verify the live index.
- Checks, each one blocking: the manifest parses; entities, files and size within set
  bounds of the live build; reachability at least 96%; the evaluation objective no more
  than 0.01 below the live build's; a few fixed queries find their entity first.
- `.github/workflows/rollback-index.yml`, by hand: restore the previous Worker version.
- Keep the schedule alive: GitHub stops scheduled workflows after 60 days without
  repository activity. Each run re-enables its own workflow through the API.
- The site build gets the index origin, so slice 7's page can use it.

## Not in scope
- Sitemaps: nothing is indexed before launch (DESIGN.md decision 17), so they move to
  slice 11.
- Alerts beyond GitHub's own e-mail on a failed run.

## Approach
Build and check on one runner, deploy with `wrangler deploy --message <build>`. Keeping
the live build means downloading its files from the live Worker (about 220 MB, one
request each) and deploying both builds, 12,877 files, under the 20,000 limit. The check
thresholds live in one file in the repo, so a legitimate big change in GLEIF's data is
a reviewed commit, not a silent pass.

## Unknowns
- Wall time on a runner for build, checks, download and upload together. Target: under
  60 minutes.
- Whether Cloudflare compresses `text/plain` assets as slice 4 assumed. Checked on the live
  index: `content-encoding` and transferred bytes for a few files.
- Whether re-enabling the workflow resets GitHub's 60-day clock. Documented by GitHub for
  activity, not for this call. Watched at the first 60-day mark.

## Done when
- A scheduled run publishes on its own, and the live `index.json` names the new build.
  Link to run.
- A run with a check forced to fail publishes nothing. Link to run.
- A rollback run restores the previous build. Link to run.
- The live index serves compressed files with the right headers. `curl -I` output.
