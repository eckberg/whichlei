import { describe, expect, it } from "vitest";
import { isPlainClick, MAX_LINK_QUERY, queryFromHash } from "./deeplink.ts";

describe("queryFromHash", () => {
  it("reads the text after #q=", () => {
    expect(queryFromHash("#q=ericsson")).toBe("ericsson");
    expect(queryFromHash("#q=Telefonaktiebolaget%20LM%20Ericsson")).toBe(
      "Telefonaktiebolaget LM Ericsson",
    );
  });

  it("takes + as a space, and %2B as a plus", () => {
    expect(queryFromHash("#q=lm+ericsson")).toBe("lm ericsson");
    expect(queryFromHash("#q=a%2Bb")).toBe("a+b");
  });

  it("decodes UTF-8, so Nordic names arrive whole", () => {
    expect(queryFromHash("#q=M%C3%A6rsk")).toBe("Mærsk");
    expect(queryFromHash("#q=Mærsk")).toBe("Mærsk");
  });

  it("keeps everything after the prefix as text, & and = included", () => {
    expect(queryFromHash("#q=a&b=c")).toBe("a&b=c");
    expect(queryFromHash("#q=q=x")).toBe("q=x");
  });

  it("is null for any other fragment", () => {
    for (const hash of ["", "#", "#about", "#Q=x", "#x=q=y", "q=x", "#?q=x", "#q", "#qq=x"]) {
      expect(queryFromHash(hash), hash).toBeNull();
    }
  });

  it("is null for a malformed escape, and never throws", () => {
    for (const hash of ["#q=%", "#q=%E0%A4%A", "#q=%ZZ", "#q=abc%C3"]) {
      expect(queryFromHash(hash), hash).toBeNull();
    }
  });

  it("trims, and is null when nothing is left", () => {
    expect(queryFromHash("#q=%20%20ericsson%20")).toBe("ericsson");
    expect(queryFromHash("#q=+ericsson+")).toBe("ericsson");
    expect(queryFromHash("#q=")).toBeNull();
    expect(queryFromHash("#q=%20+%09")).toBeNull();
  });

  it("cuts the text at 200 characters", () => {
    const long = "a".repeat(500);
    expect(queryFromHash(`#q=${long}`)).toBe("a".repeat(MAX_LINK_QUERY));
    expect(MAX_LINK_QUERY).toBe(200);
    expect(queryFromHash(`#q=${"a".repeat(200)}`)).toHaveLength(200);
  });

  it("cuts between characters, not inside an emoji, and not at a trailing space", () => {
    const emoji = encodeURIComponent("😀".repeat(300));
    const cut = queryFromHash(`#q=${emoji}`);
    expect(Array.from(cut ?? "")).toHaveLength(200);
    expect(cut).toBe("😀".repeat(200));
    expect(queryFromHash(`#q=${"a".repeat(199)}+bcd`)).toBe("a".repeat(199));
  });
});

describe("isPlainClick", () => {
  const click = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };

  it("is a primary click with no modifier", () => {
    expect(isPlainClick(click)).toBe(true);
  });

  it("is not a click that opens the link elsewhere", () => {
    expect(isPlainClick({ ...click, ctrlKey: true })).toBe(false);
    expect(isPlainClick({ ...click, metaKey: true })).toBe(false);
    expect(isPlainClick({ ...click, shiftKey: true })).toBe(false);
    expect(isPlainClick({ ...click, altKey: true })).toBe(false);
    expect(isPlainClick({ ...click, button: 1 })).toBe(false);
    expect(isPlainClick({ ...click, button: 2 })).toBe(false);
  });
});
