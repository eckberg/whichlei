import { describe, expect, test } from "vitest";
import { headersFile } from "./headers.ts";

describe("_headers", () => {
  test("one build: CORS and nosniff everywhere, the manifest revalidated, the build immutable", () => {
    expect(headersFile(["20260916-3f9a1c0e"])).toBe(
      [
        "/*",
        "  Access-Control-Allow-Origin: *",
        "  X-Content-Type-Options: nosniff",
        "",
        "/index.json",
        "  Cache-Control: no-cache",
        "",
        "/20260916-3f9a1c0e/*",
        "  Cache-Control: public, max-age=31536000, immutable",
        "",
      ].join("\n"),
    );
  });

  test("two builds: each has its own immutable rule", () => {
    const text = headersFile(["20260917-aaaaaaaa", "20260916-3f9a1c0e"]);
    expect(text).toContain(
      "/20260917-aaaaaaaa/*\n  Cache-Control: public, max-age=31536000, immutable",
    );
    expect(text).toContain(
      "/20260916-3f9a1c0e/*\n  Cache-Control: public, max-age=31536000, immutable",
    );
  });

  test("Cache-Control is never set under /*: rules that match add up", () => {
    const [everything] = headersFile(["20260916-3f9a1c0e"]).split("\n\n");
    expect(everything).not.toMatch(/Cache-Control/i);
  });

  test("a build id that is not one is refused", () => {
    expect(() => headersFile(["../x"])).toThrow(/odd/);
    expect(() => headersFile(["20260916-XYZ"])).toThrow(/odd/);
  });
});
