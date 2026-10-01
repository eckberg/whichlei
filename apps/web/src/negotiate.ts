// Which format `/lei/<LEI>` answers in, from the request's `Accept` header. HTML is the
// default: a browser, a crawler and `*/*` all get the page. A client gets Markdown or JSON only
// by ranking it above HTML, so one that does not mind (`*/*`, or `text/html` and
// `application/json` alike) is not surprised. The weight of a type is that of the most specific
// range that matches it (RFC 9110), so `*/*` counts for `text/html` too.

export type Format = "html" | "json" | "markdown";

const MEDIA_TYPES: Record<Format, string> = {
  html: "text/html",
  json: "application/json",
  markdown: "text/markdown",
};

interface Range {
  type: string;
  subtype: string;
  q: number;
}

function parseAccept(header: string): Range[] {
  const ranges: Range[] = [];
  for (const entry of header.split(",")) {
    const [media = "", ...params] = entry.split(";").map((part) => part.trim().toLowerCase());
    const [type, subtype, ...rest] = media.split("/");
    if (!type || !subtype || rest.length > 0) continue;
    let q = 1;
    for (const param of params) {
      if (!param.startsWith("q=")) continue;
      // A weight that is not a number between 0 and 1: the entry says nothing.
      q = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(param.slice(2)) ? Number(param.slice(2)) : -1;
    }
    if (q >= 0) ranges.push({ type, subtype, q });
  }
  return ranges;
}

/** The weight a header gives a media type: that of the most specific range that matches it. */
function weight(ranges: Range[], mediaType: string): number {
  const [type, subtype] = mediaType.split("/");
  let best = -1;
  let q = 0;
  for (const range of ranges) {
    const specificity =
      range.type === type && range.subtype === subtype
        ? 2
        : range.type === type && range.subtype === "*"
          ? 1
          : range.type === "*" && range.subtype === "*"
            ? 0
            : -1;
    if (specificity < 0) continue;
    if (specificity > best) {
      best = specificity;
      q = range.q;
    } else if (specificity === best) {
      q = Math.max(q, range.q);
    }
  }
  return q;
}

/**
 * Markdown or JSON if the header ranks it above `text/html` (the higher weight wins, and
 * Markdown a tie between the two), else HTML. A missing, empty or unreadable header is HTML.
 */
export function pickFormat(accept: string | null | undefined): Format {
  if (!accept) return "html";
  const ranges = parseAccept(accept);
  const page = weight(ranges, MEDIA_TYPES.html);
  const markdown = weight(ranges, MEDIA_TYPES.markdown);
  const json = weight(ranges, MEDIA_TYPES.json);
  if (markdown > page && markdown >= json) return "markdown";
  if (json > page) return "json";
  return "html";
}
