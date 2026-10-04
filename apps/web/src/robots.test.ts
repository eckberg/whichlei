import { describe, expect, it } from "vitest";
import { robotsText, TRAINING_CRAWLERS } from "./robots.ts";

describe("robotsText", () => {
  it("closes everything when indexing is off", () => {
    expect(robotsText(false, "https://whichlei.com")).toBe("User-agent: *\nDisallow: /\n");
  });

  it("lets search crawlers in, keeps training crawlers out of the records, and names the sitemap", () => {
    const text = robotsText(true, "https://whichlei.com");
    const [everyone, training] = text.split("\n\n# Crawlers that collect training data");
    expect(everyone).toContain(
      "User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=no\nAllow: /",
    );
    expect(everyone).not.toContain("Disallow");
    expect(training).toContain(
      "Content-Signal: search=yes, ai-input=yes, ai-train=no\nDisallow: /lei/",
    );
    for (const agent of TRAINING_CRAWLERS) expect(training).toContain(`User-agent: ${agent}\n`);
    expect(text.endsWith("\n\nSitemap: https://whichlei.com/sitemap.xml\n")).toBe(true);
  });

  it("names only crawlers that collect training data", () => {
    for (const agent of [
      "Googlebot",
      "Bingbot",
      "OAI-SearchBot",
      "ChatGPT-User",
      "Claude-SearchBot",
      "Claude-User",
      "PerplexityBot",
      "Perplexity-User",
    ]) {
      expect(TRAINING_CRAWLERS).not.toContain(agent);
    }
    // A token that also covers AI answers would keep records out of them (`ai-input=yes`).
    expect(TRAINING_CRAWLERS).not.toContain("Google-Extended");
    expect(TRAINING_CRAWLERS).toContain("Applebot-Extended");
    expect(new Set(TRAINING_CRAWLERS).size).toBe(TRAINING_CRAWLERS.length);
  });
});
