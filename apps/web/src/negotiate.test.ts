import { describe, expect, it } from "vitest";
import { type Format, pickFormat } from "./negotiate.ts";

const cases: [accept: string | null | undefined, expected: Format][] = [
  // No preference: the page.
  [null, "html"],
  [undefined, "html"],
  ["", "html"],
  ["*/*", "html"],
  ["text/*", "html"],
  ["text/html", "html"],
  // What a browser sends.
  ["text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8", "html"],
  // What curl and most libraries send.
  ["*/*;q=0.8", "html"],
  // Asking for Markdown or JSON by name.
  ["text/markdown", "markdown"],
  ["application/json", "json"],
  // `*/*` gives the page the same weight: no preference. Ask for JSON alone, or use `.json`.
  ["application/json, text/plain, */*", "html"],
  ["text/markdown, text/html;q=0.9", "markdown"],
  ["application/json, text/html;q=0.9", "json"],
  ["text/markdown, */*;q=0.1", "markdown"],
  ["application/json;q=0.5, text/markdown;q=0.7", "markdown"],
  ["application/json;q=0.7, text/markdown;q=0.5", "json"],
  // Both above the page: the higher weight wins, and Markdown a tie.
  ["text/markdown, application/json", "markdown"],
  ["application/json, text/markdown", "markdown"],
  // Equal weight is not a preference: the page.
  ["text/html, text/markdown", "html"],
  ["text/html, application/json", "html"],
  ["application/json, text/html", "html"],
  ["text/markdown;q=0.5, text/html;q=0.5", "html"],
  // A lower weight is not a request.
  ["text/html, text/markdown;q=0.9", "html"],
  ["text/markdown;q=0, text/html;q=0", "html"],
  ["text/markdown;q=0", "html"],
  // The most specific range sets a type's weight, whatever the others say.
  ["text/*;q=0.1, text/html;q=0.1, text/markdown", "markdown"],
  ["text/markdown;q=0.2, text/*", "html"],
  ["*/*, text/html;q=0.5, application/json;q=0.6", "markdown"],
  ["text/markdown;q=0.8, application/json;q=0.9, text/html;q=0.5", "json"],
  ["application/*", "json"],
  ["application/*, text/html;q=0.5", "json"],
  // Case, spaces and other parameters do not matter.
  ["TEXT/Markdown", "markdown"],
  ["  application/json ; charset=utf-8 ; q=0.9 , text/html ; q=0.5", "json"],
  ["text/markdown; charset=utf-8; variant=GFM", "markdown"],
  ["text/html;level=1;q=0.4, application/json;q=0.5", "json"],
  // Nothing sensible: the page.
  ["image/png", "html"],
  ["application/xml", "html"],
  ["garbage", "html"],
  [",,,;;;", "html"],
  ["application/json;q=abc", "html"],
  ["application/json;q=1.5", "html"],
  ["application/json;q=-1", "html"],
  ["text/markdown;q=2, text/html", "html"],
  ["text/markdown/extra", "html"],
];

describe("pickFormat", () => {
  it.each(cases)("%j is %s", (accept, expected) => {
    expect(pickFormat(accept)).toBe(expected);
  });

  it("reads q-values with up to three decimals", () => {
    expect(pickFormat("text/markdown;q=0.001, text/html;q=0")).toBe("markdown");
    expect(pickFormat("text/markdown;q=0.5, text/html;q=0.501")).toBe("html");
    expect(pickFormat("text/markdown;q=1.000, text/html;q=0.999")).toBe("markdown");
    expect(pickFormat("text/markdown;q=0.1234, text/html;q=0")).toBe("html");
  });
});
