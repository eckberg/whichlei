// GLEIF, mocked in the browser with Playwright's `page.route`, answering from the recorded
// fixtures of packages/gleif. Records what was asked, so a test can count requests.
import { readFileSync } from "node:fs";
import type { BrowserContext, Page, Route } from "@playwright/test";

const fixtureDir = new URL("../../../packages/gleif/fixtures/", import.meta.url);

interface Fixture {
  url: string;
  status: number;
  contentType: string | null;
  body: unknown;
}

export const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`${name}.json`, fixtureDir), "utf8")) as Fixture;

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown): Reply => ({ status: 200, body });

/** What the fixtures hold: an ISIN, a BIC (as TOMCJP22XXX) and a register number. */
export const KNOWN = {
  isin: "SE0000108656",
  bic: "TOMCJP22XXX",
  register: "HRB 30000",
  lei: "549300W9JLPW15XIFM52",
  /** Well formed, valid check digits, and no entity. */
  unknownLei: "549300ZZZZZZZZZZZZ46",
};

/** A record of the Ericsson fixture under another LEI and name. */
export function recordAs(lei: string, name: string): unknown {
  const body = structuredClone(fixture("record-ericsson").body) as {
    data: { id: string; attributes: { lei: string; entity: { legalName: { name: string } } } };
  };
  body.data.id = lei;
  body.data.attributes.lei = lei;
  body.data.attributes.entity.legalName.name = name;
  return body;
}

export class MockGleif {
  /** Every URL asked of the API, in order. */
  requests: string[] = [];
  /** Answers to records, by LEI. An LEI not here is "not found". */
  records = new Map<string, Reply>([[KNOWN.lei, ok(fixture("record-ericsson").body)]]);
  /** `busy`: every request gets a 429. `offline`: every request fails. */
  mode: "ok" | "busy" | "offline" = "ok";
  /** Seconds in the Retry-After of a 429, as a string; empty: the page cannot read one. */
  retryAfter = "";
  /** Milliseconds to hold every answer back. */
  delayMs = 0;

  private lookup(url: URL, filter: string, known: string, name: string): Reply {
    const asked = url.searchParams.get(`filter[${filter}]`);
    return ok(fixture(asked === known ? name : "lookup-no-hits").body);
  }

  private reply(rawUrl: string): Reply {
    const url = new URL(rawUrl);
    if (url.searchParams.has("filter[isin]")) {
      return this.lookup(url, "isin", KNOWN.isin, "lookup-isin");
    }
    if (url.searchParams.has("filter[bic]")) {
      return this.lookup(url, "bic", KNOWN.bic, "lookup-bic");
    }
    if (url.searchParams.has("filter[entity.registeredAs]")) {
      return this.lookup(url, "entity.registeredAs", KNOWN.register, "lookup-register-number");
    }
    const lei = /\/lei-records\/([0-9A-Z]{20})$/.exec(url.pathname)?.[1] ?? "";
    return this.records.get(lei) ?? { status: 404, body: fixture("record-not-found").body };
  }

  async handle(route: Route) {
    const url = route.request().url();
    this.requests.push(url);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.mode === "offline") return route.abort("connectionrefused");
    const cors = { "access-control-allow-origin": "*" };
    if (this.mode === "busy") {
      // Like GLEIF's, a 429 shows its Retry-After to the page only if it is exposed.
      const headers = this.retryAfter
        ? {
            ...cors,
            "retry-after": this.retryAfter,
            "access-control-expose-headers": "retry-after",
          }
        : cors;
      return route.fulfill({ status: 429, headers, body: "Too Many Requests" });
    }
    const { status, body, headers } = this.reply(url);
    return route.fulfill({
      status,
      headers: { ...cors, ...headers },
      contentType: "application/vnd.api+json",
      body: JSON.stringify(body),
    });
  }
}

/**
 * Route every request to the GLEIF API from a page, or from every page of a context, to a mock.
 * No test reaches the real API.
 */
export async function mockGleif(where: Page | BrowserContext): Promise<MockGleif> {
  const gleif = new MockGleif();
  await where.route("https://api.gleif.org/**", (route) => gleif.handle(route));
  return gleif;
}
