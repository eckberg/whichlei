// Links into the page, as pure functions so they are tested without a browser. main.ts acts
// on the answers.
//
// A search link is `/#q=<text>`: the page puts the text in the box and searches, as if typed.
// It is the fragment, not `?q=`, because the fragment never leaves the browser: the analytics
// loader strips the query string from the address (DESIGN.md decision 30), and Fathom is told
// only `/`. OpenSearch (opensearch.xml) and llms.txt name this form.

/** The longest text a link can fill in: a name, not a document. */
export const MAX_LINK_QUERY = 200;

/**
 * The text a search link holds, or null when the fragment is not one (`#about`, `#q=` with
 * nothing, a broken escape). `+` is a space, as a browser writes it in a search term.
 */
export function queryFromHash(hash: string): string | null {
  if (!hash.startsWith("#q=")) return null;
  let text: string;
  try {
    text = decodeURIComponent(hash.slice(3).replaceAll("+", " "));
  } catch {
    return null;
  }
  // Cut by characters, so an emoji is never split; and trimmed again, for a cut at a space.
  const capped = Array.from(text.trim()).slice(0, MAX_LINK_QUERY).join("").trimEnd();
  return capped === "" ? null : capped;
}

export interface ClickKeys {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** A plain primary click: the page handles it. Any other click on a link follows the link. */
export function isPlainClick(click: ClickKeys): boolean {
  return click.button === 0 && !click.ctrlKey && !click.metaKey && !click.shiftKey && !click.altKey;
}
