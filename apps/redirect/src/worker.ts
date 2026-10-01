// whichlei-redirect: every request to www.whichlei.com answers 301 to the apex, path and query
// kept. See DESIGN.md decision 28.

export interface Env {
  /** Where to send people, such as `https://whichlei.com`. */
  TARGET_ORIGIN?: string;
}

const DEFAULT_TARGET = "https://whichlei.com";

/** The address to send a request to: the target origin, then the request's path and query. */
export function redirectLocation(requestUrl: string, target: string = DEFAULT_TARGET): string {
  const { pathname, search } = new URL(requestUrl);
  // Joined as text, not resolved: a path that starts with `//` must stay a path on the target
  // and not become another host.
  return `${target.replace(/\/+$/, "")}${pathname}${search}`;
}

export default {
  fetch(request: Request, env: Env): Response {
    return new Response(null, {
      status: 301,
      headers: {
        location: redirectLocation(request.url, env.TARGET_ORIGIN || DEFAULT_TARGET),
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  },
};
