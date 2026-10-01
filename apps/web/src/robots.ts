// robots.txt. Closed to everyone until launch and on any host but the canonical one (DESIGN.md
// decision 17). On the canonical host, search crawlers and agents that fetch a page for a person
// are let in; crawlers that collect training data may read the static pages, not the records.

// Training crawlers named by their operators. Search crawlers and user-triggered agents
// (Googlebot, Bingbot, OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User,
// PerplexityBot, Perplexity-User) are not here: they stay under `*`.
export const TRAINING_CRAWLERS = [
  "GPTBot",
  "ClaudeBot",
  "CCBot",
  "Applebot-Extended",
  "Bytespider",
  "Meta-ExternalAgent",
  "Amazonbot",
  "cohere-training-data-crawler",
  "Diffbot",
  "omgili",
];

const CLOSED = "User-agent: *\nDisallow: /\n";
// Said in both groups: a crawler that matches a named group ignores `*`.
const CONTENT_SIGNAL = "Content-Signal: search=yes, ai-input=yes, ai-train=no";

/** The robots.txt body. `origin` is the canonical origin, for the sitemap's address. */
export function robotsText(indexable: boolean, origin: string): string {
  if (!indexable) return CLOSED;
  return `# whichlei. Every record comes from GLEIF under CC0. For bulk data, use GLEIF's golden copy:
# https://www.gleif.org/en/lei-data/gleif-golden-copy/download-the-golden-copy/

User-agent: *
${CONTENT_SIGNAL}
Allow: /

# Crawlers that collect training data: the static pages, not the records.
${TRAINING_CRAWLERS.map((agent) => `User-agent: ${agent}`).join("\n")}
${CONTENT_SIGNAL}
Disallow: /lei/

Sitemap: ${origin}/sitemap.xml
`;
}
