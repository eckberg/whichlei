// The analytics loader, /scripts/stats.js (DESIGN.md decisions 12 and 30). One built file, no
// inline code, on the search page and on record pages that answered 200.
//
// It does nothing unless the page is on the canonical origin, so a preview on workers.dev, a
// local run or a copy of the page never reaches Fathom. On the canonical origin it:
//   1. strips the query string from the address, because Fathom's script reads `q`, `s`,
//      `ref` and others from location.search on its own, whatever it is told to send;
//   2. trims the referrer to its origin, because Fathom sends document.referrer whole, and
//      another site's address can hold its own query (https://example.org/find?q=ericsson);
//   3. adds Fathom's script, with automatic page views off and only whichlei.com allowed;
//   4. sends one page view: "/" for the search page, "/lei/" for every record page, so the
//      LEI someone opened never reaches Fathom.
// Events are the search page's business (src/page/stats.ts), never a record page's: Fathom
// builds an event's path from the page's canonical link, and a record page's is /lei/<LEI>.
// So this file never calls trackEvent.
//
// What Fathom's script (read 2026-10-01) takes from the page, and what stops it here:
//   page view  `referrer` option, else document.referrer      both trimmed below
//   event      document.referrer only (no option)             document.referrer trimmed below
//   leave ping the referrer of the page view                  trimmed with it
//   all        location.search                                stripped above
// It never throws: analytics must not break the page.

export const FATHOM_SRC = "https://cdn.usefathom.com/script.js";
export const FATHOM_SITE = "IWPQIWKG";

/** The parts of the browser the loader uses, so a test can fake them. */
export interface LoaderEnv {
  location: { origin: string; pathname: string; search: string; hash: string };
  history: { state: unknown; replaceState(state: unknown, title: string, url: string): void };
  document: {
    referrer: string;
    createElement(tag: "script"): LoaderScript;
    head: { appendChild(node: LoaderScript): unknown };
  };
  /** Where Fathom's script puts `fathom`. */
  window: {
    fathom?: { trackPageview?: (options: { url: string; referrer: string }) => void };
  };
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

/** The referrer as its origin: where a visitor came from, never which page or what it asked. */
export function trimReferrer(referrer: string): string {
  try {
    const { origin } = new URL(referrer);
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
}

/** Returns true when it set Fathom up, false when it did nothing. */
export function loadStats(env: LoaderEnv, canonicalOrigin: string): boolean {
  try {
    // An empty origin (before launch) matches nothing.
    if (canonicalOrigin === "" || env.location.origin !== canonicalOrigin) return false;
    const { pathname, search, hash } = env.location;
    if (search !== "") env.history.replaceState(env.history.state, "", pathname + hash);
    const url = pageviewUrl(pathname);
    // Fathom reads document.referrer itself (events have no option to pass it in), so the
    // page's own answer is replaced for as long as the page lives.
    const referrer = trimReferrer(env.document.referrer);
    try {
      Object.defineProperty(env.document, "referrer", { configurable: true, get: () => referrer });
    } catch {
      // The page view still gets the trimmed referrer below.
    }
    const script = env.document.createElement("script");
    script.src = FATHOM_SRC;
    script.async = true;
    script.setAttribute("data-site", FATHOM_SITE);
    script.setAttribute("data-auto", "false");
    script.setAttribute("data-included-domains", new URL(canonicalOrigin).hostname);
    script.onload = () => {
      try {
        env.window.fathom?.trackPageview?.({ url, referrer });
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
