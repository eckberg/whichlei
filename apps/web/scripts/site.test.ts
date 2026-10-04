import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalOrigin,
  FAVICON_CSP,
  headersFile,
  indexOrigin,
  llmsTxt,
  openSearch,
  pageCsp,
  searchPage,
  sitemap,
} from "./site.ts";

describe("indexOrigin", () => {
  it("is empty when nothing is configured", () => {
    expect(indexOrigin(undefined)).toBe("");
    expect(indexOrigin("")).toBe("");
    expect(indexOrigin("  ")).toBe("");
  });

  it("keeps the origin and drops a path or trailing slash", () => {
    expect(indexOrigin("https://index.whichlei.com/")).toBe("https://index.whichlei.com");
    expect(indexOrigin("http://127.0.0.1:8788/index.json")).toBe("http://127.0.0.1:8788");
  });

  it("refuses what is not an http(s) URL", () => {
    expect(() => indexOrigin("ftp://index.example")).toThrow();
    expect(() => indexOrigin("index.example")).toThrow();
  });
});

describe("pageCsp", () => {
  it("allows only the site, the index, the GLEIF API and Fathom", () => {
    const csp = pageCsp("https://index.whichlei.com");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(
      "connect-src 'self' https://index.whichlei.com https://api.gleif.org https://cdn.usefathom.com;",
    );
    expect(csp).toContain("script-src 'self' https://cdn.usefathom.com;");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("img-src 'self' data: https://cdn.usefathom.com;");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("google");
  });

  it("leaves the index out when there is none", () => {
    expect(pageCsp("")).toContain(
      "connect-src 'self' https://api.gleif.org https://cdn.usefathom.com;",
    );
  });
});

describe("canonicalOrigin", () => {
  it("reads the variable from wrangler.jsonc, comments and all", () => {
    const text = `{
  "vars": {
    // The site's own origin, such as "https://whichlei.com".
    "CANONICAL_ORIGIN": "https://whichlei.com/",
  }
}`;
    expect(canonicalOrigin(text)).toBe("https://whichlei.com");
  });

  it("is empty before launch and refuses a missing variable or a bad one", () => {
    expect(canonicalOrigin('{ "CANONICAL_ORIGIN": "" }')).toBe("");
    expect(() => canonicalOrigin("{}")).toThrow();
    expect(() => canonicalOrigin('{ "CANONICAL_ORIGIN": "whichlei.com" }')).toThrow();
  });

  it("is the apex in the real wrangler.jsonc", () => {
    const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(canonicalOrigin(wrangler)).toBe("https://whichlei.com");
  });
});

describe("searchPage", () => {
  const APEX = "https://whichlei.com";
  const head = (description: string, title = "whichlei · find an LEI") =>
    `<!doctype html>\n<meta name="description" content="${description}">\n<title>${title}</title>\n<link rel=icon href=x>\n`;
  const page = head("Find the LEI of a company, while you type.");

  it("links the canonical apex after the title", () => {
    expect(searchPage(page, APEX)).toContain(
      '</title>\n<link rel="canonical" href="https://whichlei.com/">\n',
    );
  });

  it("adds the Open Graph and Twitter tags, from the page's own title and description", () => {
    const out = searchPage(page, APEX);
    for (const tag of [
      '<meta property="og:type" content="website">',
      '<meta property="og:site_name" content="whichlei">',
      '<meta property="og:title" content="whichlei · find an LEI">',
      '<meta property="og:description" content="Find the LEI of a company, while you type.">',
      '<meta property="og:url" content="https://whichlei.com/">',
      '<meta property="og:image" content="https://whichlei.com/icon-512.png">',
      '<meta name="twitter:card" content="summary">',
    ]) {
      expect(out, tag).toContain(tag);
    }
    // After the title, before what the page already had after it.
    expect(out.indexOf("og:type")).toBeGreaterThan(out.indexOf("</title>"));
    expect(out.indexOf("og:image")).toBeLessThan(out.indexOf("<link rel=icon"));
  });

  it("adds the JSON-LD of a WebSite, as a data block", () => {
    const out = searchPage(page, APEX);
    const block = /<script type="application\/ld\+json">(.*)<\/script>/.exec(out)?.[1] ?? "";
    expect(JSON.parse(block)).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "whichlei",
      url: "https://whichlei.com/",
      description: "Find the LEI of a company, while you type.",
    });
    expect(out.match(/<script/g)).toHaveLength(1);
  });

  it("keeps an escaped description escaped in a tag and plain in the JSON, and cannot close the script", () => {
    const out = searchPage(head("A &amp; B &lt;/script&gt;", "A &amp; B"), APEX);
    expect(out).toContain('<meta property="og:title" content="A &amp; B">');
    expect(out).toContain('<meta property="og:description" content="A &amp; B &lt;/script&gt;">');
    const block = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(out)?.[1] ?? "";
    expect(JSON.parse(block).description).toBe("A & B </script>");
    expect(block).not.toContain("</script>");
    expect(out.match(/<\/script>/g)).toHaveLength(1);
  });

  it("links the OpenSearch description, which the build writes only with a canonical origin", () => {
    expect(searchPage(page, APEX)).toContain(
      '<link rel="search" type="application/opensearchdescription+xml" title="whichlei" href="/opensearch.xml">',
    );
  });

  it("adds nothing before launch: no canonical link, no tags, no link to a file that is not there", () => {
    const out = searchPage(page, "");
    expect(out).toBe(page);
    expect(out).not.toContain("opensearch");
  });

  it("refuses a page it cannot read the title or description of", () => {
    expect(() => searchPage("<!doctype html>\n<title>x</title>", APEX)).toThrow();
    expect(() =>
      searchPage('<meta name="description" content="d">\n<title>x</title>', APEX),
    ).toThrow();
    expect(() =>
      searchPage('<meta name="description" content="d">\n<title></title>\n', APEX),
    ).toThrow();
    expect(() =>
      searchPage('<meta name="description" content="">\n<title>x</title>\n', APEX),
    ).toThrow();
  });
});

describe("the head of the real search page", () => {
  const html = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");

  it("names what the page does, in the title and the description", () => {
    expect(html).toContain(
      "<title>whichlei · LEI lookup by name, ISIN, BIC or register number</title>",
    );
    expect(html).toContain(
      '<meta name="description" content="Find the LEI of a company, fund or public body by name, ISIN, BIC or national register number, while you type. Data from GLEIF, updated daily. No account, no cookies.">',
    );
  });

  it("links the icons and the about page", () => {
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32">');
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    // The OpenSearch link is added by searchPage, with the file it names.
    expect(html).not.toContain("opensearch");
    expect(html).toContain('<a class="btn" href="/about" id="about-btn">about</a>');
    expect(html).not.toContain("data:image");
  });

  it("points a visitor without JavaScript to the records and the about page", () => {
    expect(html).toContain(
      "whichlei needs JavaScript to search. To open a record without it, go to /lei/ followed by the LEI.",
    );
    expect(html).toContain('<a href="/about">About whichlei</a>');
  });

  it("builds into the head the launch needs", () => {
    const out = searchPage(html, "https://whichlei.com");
    expect(out).toContain('<meta property="og:title" content="whichlei · LEI lookup by name,');
    expect(out).toContain('"@type":"WebSite"');
    expect(out).toContain('href="/opensearch.xml"');
    expect(searchPage(html, "")).not.toContain("opensearch");
  });
});

describe("sitemap", () => {
  it("lists the search page and the about page, and no record", () => {
    const xml = sitemap("https://whichlei.com");
    expect(xml).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://whichlei.com/</loc></url>
<url><loc>https://whichlei.com/about</loc></url>
</urlset>
`);
    expect(xml).not.toContain("/lei/");
    expect(xml).not.toContain("lastmod");
  });
});

describe("openSearch", () => {
  it("sends the term after the fragment of the search page", () => {
    expect(openSearch("https://whichlei.com")).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
<ShortName>whichlei</ShortName>
<Description>Find an LEI by name, ISIN, BIC or register number</Description>
<InputEncoding>UTF-8</InputEncoding>
<Image width="16" height="16" type="image/x-icon">https://whichlei.com/favicon.ico</Image>
<Url type="text/html" method="get" template="https://whichlei.com/#q={searchTerms}"/>
</OpenSearchDescription>
`);
  });
});

describe("llmsTxt", () => {
  const text = llmsTxt("https://whichlei.com");

  it("names the origin wherever the text has one, and leaves the placeholders alone", () => {
    expect(text).not.toContain("<origin>");
    expect(text).toContain("- `https://whichlei.com/lei/<LEI>`: one record as an HTML page");
    expect(text).toContain("- `https://whichlei.com/lei/<LEI>.json`: the same record as JSON.");
    expect(text).toContain("- `https://whichlei.com/lei/<LEI>.md`: the same record as Markdown.");
    expect(text).toContain(
      "To open the search with text filled in: `https://whichlei.com/#q=<text>`.",
    );
    expect(text).toContain("- About: https://whichlei.com/about\n");
    expect(text).toContain("- Source code: https://github.com/eckberg/whichlei\n");
  });

  it("points at GLEIF for search without a browser, and asks crawlers to keep off /lei/", () => {
    expect(text).toContain(
      "- Names: `https://api.gleif.org/api/v1/autocompletions?field=fulltext&q=<text>`",
    );
    expect(text).toContain("filter[isin]=<ISIN>`");
    expect(text).toContain("filter[bic]=<BIC>`");
    expect(text).toContain("filter[entity.registeredAs]=<number>`");
    expect(text).toContain("Please do not crawl `/lei/` for bulk data.");
  });

  it("is Markdown that starts with the name and ends in one newline", () => {
    expect(text.startsWith("# whichlei\n\n> Find the Legal Entity Identifier (LEI)")).toBe(true);
    expect(text.endsWith("whichlei\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});

describe("headersFile", () => {
  const file = headersFile("https://index.whichlei.com");
  const blocks = file.trim().split("\n\n");

  it("sets the site-wide headers on every path", () => {
    expect(blocks[0]).toBe(`/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: interest-cohort=()
  Content-Security-Policy: ${pageCsp("https://index.whichlei.com")}`);
  });

  it("gives /favicon.svg a policy of its own, after the site-wide one, and detaches that one", () => {
    expect(blocks).toHaveLength(2);
    // Rules apply in order, and `!` removes what an earlier rule set; so the site-wide one goes
    // and this one stays (the two would otherwise be joined with a comma).
    expect(blocks[1]).toBe(`/favicon.svg
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`);
    expect(FAVICON_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'");
  });

  it("stays within Cloudflare's limits: 100 rules, 2,000 characters a line", () => {
    expect(blocks.length).toBeLessThanOrEqual(100);
    for (const line of file.split("\n")) expect(line.length).toBeLessThan(2000);
  });

  it("keeps unsafe-inline off the page's own policy", () => {
    expect(blocks[0]).not.toContain("unsafe-inline");
  });
});

describe("the launch settings of wrangler.jsonc", () => {
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

  it("serves the apex as a custom domain, and keeps workers.dev", () => {
    expect(wrangler).toContain('"routes": [{ "pattern": "whichlei.com", "custom_domain": true }]');
    expect(wrangler).toContain('"workers_dev": true');
  });

  it("lets crawlers in, on the canonical host only", () => {
    expect(wrangler).toContain('"ALLOW_INDEXING": "true"');
    expect(wrangler).toContain('"CANONICAL_ORIGIN": "https://whichlei.com"');
  });

  it("reads the index from index.whichlei.com, in every place that names it", () => {
    expect(wrangler).toContain('"INDEX_ORIGIN": "https://index.whichlei.com"');
    for (const file of ["deploy-site.yml", "publish-index.yml", "rollback-index.yml"]) {
      const workflow = readFileSync(
        new URL(`../../../.github/workflows/${file}`, import.meta.url),
        "utf8",
      );
      expect(workflow, file).toMatch(/INDEX_ORIGIN: https:\/\/index\.whichlei\.com\s/);
      expect(workflow, file).not.toContain("lumenspring");
    }
  });

  it("is checked against the apex by the deploy workflow, in a production environment", () => {
    const workflow = readFileSync(
      new URL("../../../.github/workflows/deploy-site.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("name: production");
    expect(workflow).toContain("url: https://whichlei.com");
    expect(workflow).toContain("LIVE_URL: https://whichlei.com");
  });
});

describe("the index origin of the Worker", () => {
  it("is the one the site is built with", () => {
    const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const workflow = readFileSync(
      new URL("../../../.github/workflows/deploy-site.yml", import.meta.url),
      "utf8",
    );
    const worker = /"INDEX_ORIGIN":\s*"([^"]*)"/.exec(wrangler)?.[1];
    const built = /INDEX_ORIGIN:\s*(\S+)/.exec(workflow)?.[1];
    expect(worker).toMatch(/^https:\/\//);
    expect(worker).toBe(built);
  });
});
