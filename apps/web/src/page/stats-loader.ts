// The analytics loader, /scripts/stats.js (DESIGN.md decisions 12 and 30). One built file, no
// inline code, on the search page and on record pages that answered 200.
//
// It does nothing unless the page is on the canonical origin, so a preview on workers.dev, a
// local run or a copy of the page never reaches Fathom. On the canonical origin it:
//   1. strips the query string from the address, because Fathom's script reads `q`, `s`,
//      `ref` and others from location.search on its own, whatever it is told to send;
//   2. adds Fathom's script, with automatic page views off and only whichlei.com allowed;
//   3. sends one page view: "/" for the search page, "/lei/" for every record page, so the
//      LEI someone opened never reaches Fathom.
// It never throws: analytics must not break the page.

export const FATHOM_SRC = "https://cdn.usefathom.com/script.js";
export const FATHOM_SITE = "IWPQIWKG";

/** The parts of the browser the loader uses, so a test can fake them. */
export interface LoaderEnv {
  location: { origin: string; pathname: string; search: string; hash: string };
  history: { state: unknown; replaceState(state: unknown, title: string, url: string): void };
  document: {
    createElement(tag: "script"): LoaderScript;
    head: { appendChild(node: LoaderScript): unknown };
  };
  /** Where Fathom's script puts `fathom`. */
  window: { fathom?: { trackPageview?: (options: { url: string }) => void } };
}

export interface LoaderScript {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  setAttribute(name: string, value: string): void;
}

/** The URL Fathom is told: the page's kind, never what it holds. */
export function pageviewUrl(pathname: string): "/" | "/lei/" {
  return pathname.startsWith("/lei/") ? "/lei/" : "/";
}

/** Returns true when it set Fathom up, false when it did nothing. */
export function loadStats(env: LoaderEnv, canonicalOrigin: string): boolean {
  try {
    // An empty origin (before launch) matches nothing.
    if (canonicalOrigin === "" || env.location.origin !== canonicalOrigin) return false;
    const { pathname, search, hash } = env.location;
    if (search !== "") env.history.replaceState(env.history.state, "", pathname + hash);
    const url = pageviewUrl(pathname);
    const script = env.document.createElement("script");
    script.src = FATHOM_SRC;
    script.async = true;
    script.setAttribute("data-site", FATHOM_SITE);
    script.setAttribute("data-auto", "false");
    script.setAttribute("data-included-domains", new URL(canonicalOrigin).hostname);
    script.onload = () => {
      try {
        env.window.fathom?.trackPageview?.({ url });
      } catch {
        // Nothing to do: the page works without its count.
      }
    };
    env.document.head.appendChild(script);
    return true;
  } catch {
    return false;
  }
}
