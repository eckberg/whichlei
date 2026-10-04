import { describe, expect, it } from "vitest";
import { renderAboutPage } from "./about-page.ts";
import { aboutHtml } from "./page/view.ts";

const meta = (page: string, attribute: string, key: string) =>
  new RegExp(`<meta ${attribute}="${key}" content="([^"]*)">`).exec(page)?.[1];

describe("renderAboutPage", () => {
  const page = renderAboutPage("https://whichlei.com");

  it("is a full document with its title, description and canonical link", () => {
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain("<title>About · whichlei</title>");
    expect(meta(page, "name", "description")).toBe(
      "What whichlei is, where its data comes from, and what it counts.",
    );
    expect(page).toContain('<link rel="canonical" href="https://whichlei.com/about">');
    expect(page).toContain('<link rel="stylesheet" href="/styles/record.css">');
  });

  it("has the icons and the social tags of a record page", () => {
    expect(page).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32">');
    expect(page).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(page).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    expect(meta(page, "property", "og:type")).toBe("website");
    expect(meta(page, "property", "og:site_name")).toBe("whichlei");
    expect(meta(page, "property", "og:title")).toBe("About · whichlei");
    expect(meta(page, "property", "og:description")).toBe(meta(page, "name", "description"));
    expect(meta(page, "property", "og:url")).toBe("https://whichlei.com/about");
    expect(meta(page, "property", "og:image")).toBe("https://whichlei.com/icon-512.png");
    expect(meta(page, "name", "twitter:card")).toBe("summary");
  });

  it("holds the man page of the search page, as it is", () => {
    expect(page).toContain(aboutHtml(null));
    expect(page).toContain("WHICHLEI(1)");
    expect(page).toContain("<h2>PRIVACY</h2>");
  });

  it("has one h1, for screen readers: the man page's title is its header line", () => {
    expect(page.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(page).toContain('<h1 class="sr-only">About whichlei</h1>');
  });

  it("has no script at all: analytics count only / and /lei/", () => {
    expect(page).not.toContain("<script");
    expect(page).not.toMatch(/\son[a-z]+=/);
    expect(page).not.toContain("stats.js");
  });

  it("leaves out what needs an origin when there is none", () => {
    const bare = renderAboutPage("");
    expect(bare).not.toContain('rel="canonical"');
    expect(bare).not.toContain("og:url");
    expect(bare).not.toContain("og:image");
    expect(meta(bare, "property", "og:title")).toBe("About · whichlei");
    expect(bare).toContain("<title>About · whichlei</title>");
  });
});
