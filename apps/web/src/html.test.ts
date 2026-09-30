import { describe, expect, it } from "vitest";
import { escapeHtml, html, raw } from "./html.ts";

describe("html", () => {
  it("escapes interpolated values", () => {
    const hostile = `<script>alert("x")</script> & 'y'`;
    expect(html`<p>${hostile}</p>`.value).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;</p>",
    );
  });

  it("escapes inside attributes", () => {
    expect(html`<a href="${'" onclick="x'}">`.value).toBe('<a href="&quot; onclick=&quot;x">');
  });

  it("keeps nested html and joins lists", () => {
    const items = ["a", "<b>"].map((item) => html`<li>${item}</li>`);
    expect(html`<ul>${items}</ul>`.value).toBe("<ul><li>a</li><li>&lt;b&gt;</li></ul>");
  });

  it("leaves out null, undefined and false, and prints numbers and zero", () => {
    expect(html`${null}|${undefined}|${false}|${0}|${12}`.value).toBe("|||0|12");
  });

  it("does not escape what raw marks", () => {
    expect(html`${raw("<b>ok</b>")}`.value).toBe("<b>ok</b>");
  });

  it("escapes plain text", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });
});
