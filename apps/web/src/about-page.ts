// The about page, `/about`: a static HTML document the build writes to `dist/about.html`. The
// text is the man page the search page shows for `?` (page/view.ts), so the two cannot differ.
// No script: analytics see only `/` and `/lei/` (DESIGN.md decision 30).

import { html, raw } from "./html.ts";
import { aboutHtml } from "./page/view.ts";
import { renderPage, socialTags } from "./record.ts";

const TITLE = "About · whichlei";
const DESCRIPTION = "What whichlei is, where its data comes from, and what it counts.";

/** The page as a full document. `canonicalOrigin` is empty when the site has none yet. */
export function renderAboutPage(canonicalOrigin: string): string {
  const url = canonicalOrigin === "" ? null : `${canonicalOrigin}/about`;
  const head = html`<meta name="description" content="${DESCRIPTION}">
${url === null ? "" : html`<link rel="canonical" href="${url}">\n`}${socialTags({
  title: TITLE,
  description: DESCRIPTION,
  origin: canonicalOrigin,
  url,
})}`;
  // The man page's own title is its header line; the h1 names the page for screen readers and
  // search engines, as the search page's header does there.
  const body = html`<main class="about">
<h1 class="sr-only">About whichlei</h1>
${raw(aboutHtml(null))}
</main>`;
  return renderPage({ title: TITLE, head, body });
}
