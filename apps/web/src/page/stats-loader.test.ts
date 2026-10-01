import { describe, expect, it } from "vitest";
import {
  FATHOM_SITE,
  FATHOM_SRC,
  type LoaderEnv,
  type LoaderScript,
  loadStats,
  pageviewUrl,
} from "./stats-loader.ts";

const APEX = "https://whichlei.com";

function rig(where: { origin?: string; pathname?: string; search?: string; hash?: string } = {}) {
  const location = { origin: APEX, pathname: "/", search: "", hash: "", ...where };
  const replaced: { state: unknown; url: string }[] = [];
  const scripts: (LoaderScript & { attributes: Record<string, string> })[] = [];
  const views: { url: string }[] = [];
  const env: LoaderEnv = {
    location,
    history: {
      state: { kept: true },
      replaceState: (state, _title, url) => replaced.push({ state, url }),
    },
    document: {
      createElement: () => {
        const attributes: Record<string, string> = {};
        const script = {
          src: "",
          async: false,
          onload: null,
          attributes,
          setAttribute: (name: string, value: string) => {
            attributes[name] = value;
          },
        };
        scripts.push(script);
        return script;
      },
      head: { appendChild: () => {} },
    },
    window: { fathom: { trackPageview: (options) => views.push(options) } },
  };
  return { env, replaced, scripts, views };
}

describe("pageviewUrl", () => {
  it("collapses every record page to /lei/", () => {
    expect(pageviewUrl("/lei/549300W9JLPW15XIFM52")).toBe("/lei/");
    expect(pageviewUrl("/lei/")).toBe("/lei/");
  });

  it("is / for the search page and anything else", () => {
    expect(pageviewUrl("/")).toBe("/");
    expect(pageviewUrl("/leisure")).toBe("/");
  });
});

describe("loadStats", () => {
  it("does nothing off the canonical origin", () => {
    for (const origin of [
      "https://whichlei-site.lumenspring.workers.dev",
      "http://localhost:8787",
      "https://www.whichlei.com",
      "http://whichlei.com",
      "https://whichlei.com.evil.example",
    ]) {
      const r = rig({ origin, search: "?q=x" });
      expect(loadStats(r.env, APEX), origin).toBe(false);
      expect(r.scripts, origin).toHaveLength(0);
      expect(r.replaced, origin).toHaveLength(0);
    }
  });

  it("does nothing while no canonical origin is set", () => {
    const r = rig({ origin: "" });
    expect(loadStats(r.env, "")).toBe(false);
    expect(r.scripts).toHaveLength(0);
  });

  it("adds Fathom's script, set to count nothing by itself and only on whichlei.com", () => {
    const r = rig();
    expect(loadStats(r.env, APEX)).toBe(true);
    expect(r.scripts).toHaveLength(1);
    const script = r.scripts[0];
    expect(script?.src).toBe(FATHOM_SRC);
    expect(script?.src).toBe("https://cdn.usefathom.com/script.js");
    expect(script?.attributes).toEqual({
      "data-site": "IWPQIWKG",
      "data-auto": "false",
      "data-included-domains": "whichlei.com",
    });
    expect(FATHOM_SITE).toBe("IWPQIWKG");
  });

  it("sends one page view for / on the search page, once the script has loaded", () => {
    const r = rig({ pathname: "/" });
    loadStats(r.env, APEX);
    expect(r.views).toEqual([]);
    r.scripts[0]?.onload?.();
    expect(r.views).toEqual([{ url: "/" }]);
  });

  it("sends /lei/ for a record page, never the LEI", () => {
    const r = rig({ pathname: "/lei/549300W9JLPW15XIFM52" });
    loadStats(r.env, APEX);
    r.scripts[0]?.onload?.();
    expect(r.views).toEqual([{ url: "/lei/" }]);
    expect(JSON.stringify(r.views)).not.toContain("549300");
  });

  it("strips the query string before Fathom is added, keeping the path and the hash", () => {
    const r = rig({ pathname: "/lei/549300W9JLPW15XIFM52", search: "?q=ericsson&utm_source=x" });
    loadStats(r.env, APEX);
    expect(r.replaced).toEqual([{ state: { kept: true }, url: "/lei/549300W9JLPW15XIFM52" }]);
    const home = rig({ search: "?q=ericsson", hash: "#about" });
    loadStats(home.env, APEX);
    expect(home.replaced).toEqual([{ state: { kept: true }, url: "/#about" }]);
  });

  it("leaves the address alone when there is no query", () => {
    const r = rig();
    loadStats(r.env, APEX);
    expect(r.replaced).toEqual([]);
  });

  it("never throws: not from the browser, not from Fathom", () => {
    const broken = rig();
    broken.env.history.replaceState = () => {
      throw new Error("no history");
    };
    broken.env.location.search = "?q=x";
    expect(() => loadStats(broken.env, APEX)).not.toThrow();
    expect(loadStats(broken.env, APEX)).toBe(false);

    const bad = rig();
    bad.env.window = {
      fathom: {
        trackPageview: () => {
          throw new Error("fathom broke");
        },
      },
    };
    loadStats(bad.env, APEX);
    expect(() => bad.scripts[0]?.onload?.()).not.toThrow();

    const missing = rig();
    missing.env.window = {};
    loadStats(missing.env, APEX);
    expect(() => missing.scripts[0]?.onload?.()).not.toThrow();

    expect(() => loadStats({} as LoaderEnv, APEX)).not.toThrow();
    expect(() => loadStats(rig().env, "not a url")).not.toThrow();
  });
});
