# whichlei: notes for Claude Code

Read DESIGN.md first. It is the source of truth for what this is, why, and the decisions
behind it. Keep it in sync with the code.

## Communication
- Be concise. Lead with the answer or the outcome, then only what the reader needs to act.
- Plain words, short sentences. No filler, no restating the question, no narrating process.
- This applies everywhere: chat, commit messages, PR descriptions, review comments, docs.

## Process
The agent executes. The owner sets intent and reviews.
- Work is split into the slices in PLAN.md. Each slice gets a spec in `docs/specs/`,
  approved before work starts.
- Done means evidenced: a number, a passing test, a screenshot. Not an assertion.
- Measure before deciding. Estimates do not become architecture.
- A new product decision goes into the DESIGN.md decisions table, with its reason.
- Non-goals in DESIGN.md are closed with a link, not argued.

## Sub-agents
Split work into sub-agents when parts can run in parallel or would flood the main context.
Pick the model per task:
- Haiku: lookups, summaries, mechanical edits.
- Sonnet: implementation, data plumbing, routine checks.
- Opus: design, analysis, ranking and relevance, adversarial review.

Give each a self-contained brief: inputs, outputs, constraints. Check the result before
relying on it; have a different sub-agent verify anything that closes a slice.

## Ask first
- Changes to goals or non-goals in DESIGN.md.
- Anything with a recurring cost.
- Collecting any data beyond the existing aggregate analytics.
- Deploys and releases.

## Gotchas
- Unicode NFKD does not fold `æ ø ß ł đ ð þ œ`. Apply an explicit table first, or Nordic,
  German and Polish names drop out of the index: "Mærsk" tokenises to `m` + `rsk`.
- Input type cannot be read from shape alone. "ERICSSON" is a valid BIC (`SS` is South
  Sudan). Run the candidate lookups and let the hits decide.
- LEI check digits are ISO 7064 mod 97-10. Validate in the browser before any request.

## Conventions
- Plain imperative commit subjects. English in code, docs and issues.
- No session links in commits, pull requests, issues or docs.
