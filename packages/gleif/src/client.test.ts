import { describe, expect, test } from "vitest";
import {
  fetchIsins,
  fetchNames,
  fetchRecord,
  findByBic,
  findByIsin,
  findByRegisterNumber,
} from "./client.ts";
import { GleifError } from "./errors.ts";
import { replay, respond } from "./replay.ts";

const ERICSSON = "549300W9JLPW15XIFM52";

describe("fetchRecord", () => {
  test("reads a listed company in full", async () => {
    const { fetch, calls } = replay("record-ericsson");
    const record = await fetchRecord(ERICSSON, { fetch });
    expect(calls).toHaveLength(1);
    expect(record).toEqual({
      lei: ERICSSON,
      legalName: { name: "Telefonaktiebolaget LM Ericsson", language: "sv" },
      otherNames: [],
      entityStatus: "ACTIVE",
      registrationStatus: "ISSUED",
      legalAddress: {
        language: "sv",
        lines: ["Torshamnsgatan 21"],
        number: null,
        numberWithinBuilding: null,
        mailRouting: null,
        city: "Stockholm",
        region: "SE-AB",
        country: "SE",
        postalCode: "164 83",
      },
      headquartersAddress: {
        language: "sv",
        lines: ["Torshamnsgatan 21"],
        number: null,
        numberWithinBuilding: null,
        mailRouting: null,
        city: "Stockholm",
        region: "SE-AB",
        country: "SE",
        postalCode: "164 83",
      },
      registrationAuthority: { id: "RA000544", other: null },
      registerNumber: "556016-0680",
      legalForm: { code: "XJHM", other: null },
      jurisdiction: "SE",
      category: "GENERAL",
      subCategory: null,
      creationDate: "1918-08-19T00:00:00Z",
      initialRegistrationDate: "2013-09-16T14:34:00Z",
      lastUpdateDate: "2026-07-16T09:07:00Z",
      nextRenewalDate: "2027-09-12T00:00:00Z",
      corroborationLevel: "FULLY_CORROBORATED",
      managingLou: "549300O897ZC5H7CY412",
      expiration: { date: null, reason: null },
      successors: [],
      bics: ["TEERSESSXXX"],
      directParent: { kind: "exception", reason: "NO_KNOWN_PERSON", reference: null },
      ultimateParent: { kind: "exception", reason: "NO_KNOWN_PERSON", reference: null },
      source: {
        apiUrl: `https://api.gleif.org/api/v1/lei-records/${ERICSSON}`,
        webUrl: `https://search.gleif.org/#/record/${ERICSSON}`,
        goldenCopyDate: "2026-09-30T08:00:00Z",
      },
    });
  });

  test("gives the parent LEIs of a subsidiary", async () => {
    const record = await fetchRecord("98450057EFE9D01O5335", {
      fetch: replay("record-subsidiary").fetch,
    });
    expect(record.directParent).toEqual({ kind: "reported", lei: ERICSSON });
    expect(record.ultimateParent).toEqual({ kind: "reported", lei: ERICSSON });
    expect(record.bics).toEqual([]);
    expect(record.legalAddress?.mailRouting).toBe("c/o CORPORATION SERVICE COMPANY");
    // The headquarters differ from the legal address.
    expect(record.headquartersAddress?.city).toBe("Holmdel");
  });

  test("gives the reporting exception when there is no parent", async () => {
    const record = await fetchRecord("894500VYHF8PY754L456", {
      fetch: replay("record-exception").fetch,
    });
    expect(record.directParent).toEqual({
      kind: "exception",
      reason: "NATURAL_PERSONS",
      reference: null,
    });
    expect(record.ultimateParent).toMatchObject({ kind: "exception", reason: "NATURAL_PERSONS" });
  });

  test("reads a fund, whose legal form is free text", async () => {
    const record = await fetchRecord("2549006ZR9L6XM2MCE35", {
      fetch: replay("record-fund").fetch,
    });
    expect(record.category).toBe("FUND");
    expect(record.legalForm).toEqual({ code: "8888", other: "FUND" });
    expect(record.headquartersAddress?.lines).toEqual(["C/O FCG Fonder AB", "Ostermalmstorg 1"]);
  });

  test("keeps a lapsed registration apart from the entity status", async () => {
    const record = await fetchRecord("9845006B0E5096QB7036", {
      fetch: replay("record-lapsed").fetch,
    });
    expect(record.entityStatus).toBe("ACTIVE");
    expect(record.registrationStatus).toBe("LAPSED");
    expect(record.nextRenewalDate).toBe("2026-09-29T11:53:57Z");
    expect(record.legalAddress?.region).toBeNull();
  });

  test("reads a branch: no parents, the jurisdiction of its head office", async () => {
    const record = await fetchRecord("636700XQVY1M7XLO8T61", {
      fetch: replay("record-branch").fetch,
    });
    expect(record.category).toBe("BRANCH");
    expect(record.directParent).toEqual({ kind: "none" });
    expect(record.ultimateParent).toEqual({ kind: "none" });
    expect(record.jurisdiction).toBe("DE");
    expect(record.legalAddress?.country).toBe("SE");
  });

  test("reads a retired entity with a previous name and a successor", async () => {
    const record = await fetchRecord("984500F6D5C0F4FH0992", {
      fetch: replay("record-retired").fetch,
    });
    expect(record.entityStatus).toBe("INACTIVE");
    expect(record.registrationStatus).toBe("RETIRED");
    expect(record.otherNames).toEqual([
      {
        name: "Rågårds i Karlskrona Aktiebolag",
        language: "sv",
        kind: "previous",
        type: "PREVIOUS_LEGAL_NAME",
      },
    ]);
    expect(record.successors).toEqual([{ lei: null, name: "Bolagsstiftarna Sirga AB" }]);
  });

  test("reads a legal name that is not in Latin script, with its English name", async () => {
    const record = await fetchRecord("5493006W3QUS5LMH6R84", {
      fetch: replay("record-toyota").fetch,
    });
    expect(record.legalName).toEqual({ name: "トヨタ自動車株式会社", language: "ja" });
    expect(record.otherNames).toEqual([
      {
        name: "Toyota Motor Corporation",
        language: "en",
        kind: "alternative-language",
        type: "ALTERNATIVE_LANGUAGE_LEGAL_NAME",
      },
    ]);
    expect(record.registrationAuthority.id).toBe("RA000412");
  });

  test("marks transliterated names", async () => {
    const record = await fetchRecord("529900E3CDUZL6H6GX76", {
      fetch: replay("record-transliterated").fetch,
    });
    expect(record.otherNames.map((name) => name.kind)).toEqual(["transliterated"]);
  });

  test("names an unknown name type as other", async () => {
    const { fetch } = replay("record-ericsson", (body) => {
      const document = body as { data: { attributes: { entity: { otherNames: unknown[] } } } };
      document.data.attributes.entity.otherNames.push({ name: "E", language: "en", type: "NEW" });
      return document;
    });
    const record = await fetchRecord(ERICSSON, { fetch });
    expect(record.otherNames).toEqual([{ name: "E", language: "en", kind: "other", type: "NEW" }]);
  });

  test("asks for the parents in the same request, with only an Accept header", async () => {
    let init: RequestInit | undefined;
    const { fetch } = replay("record-ericsson");
    await fetchRecord(ERICSSON, {
      fetch: (url, requestInit) => {
        init = requestInit;
        return fetch(url, requestInit);
      },
    });
    expect(init?.headers).toEqual({ accept: "application/vnd.api+json" });
  });

  test("encodes the LEI into the path", async () => {
    const { fetch, calls } = respond(404, "");
    await fetchRecord("../x?y", { fetch }).catch(() => {});
    expect(calls[0]).toContain("/lei-records/..%2Fx%3Fy?");
  });

  test("uses the base URL, without a trailing slash", async () => {
    const { fetch, calls } = respond(404, "");
    await fetchRecord(ERICSSON, { fetch, baseUrl: "https://proxy.example/gleif/" }).catch(() => {});
    expect(calls[0]).toBe(
      `https://proxy.example/gleif/lei-records/${ERICSSON}?include=direct-parent%2Cultimate-parent`,
    );
  });

  test("builds the source URL from the base URL when GLEIF sends no self link", async () => {
    const { fetch } = replay("record-ericsson", (body) => {
      const document = body as { data: { links?: unknown } };
      delete document.data.links;
      return document;
    });
    const record = await fetchRecord(ERICSSON, { fetch });
    expect(record.source.apiUrl).toBe(`https://api.gleif.org/api/v1/lei-records/${ERICSSON}`);
  });

  test("uses the global fetch when none is given", async () => {
    const original = globalThis.fetch;
    const { fetch, calls } = replay("record-ericsson");
    globalThis.fetch = fetch as typeof globalThis.fetch;
    try {
      await fetchRecord(ERICSSON);
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toHaveLength(1);
  });
});

describe("fetchIsins", () => {
  test("returns one page and says how many there are", async () => {
    const { fetch } = replay("isins-ericsson");
    const page = await fetchIsins(ERICSSON, { fetch, pageSize: 3 });
    expect(page).toEqual({
      items: ["SE0000805277", "SE0000285140", "US2948215098"],
      total: 8,
      page: 1,
      pageSize: 3,
      pageCount: 3,
      goldenCopyDate: "2026-09-30T08:00:00Z",
    });
  });

  test("asks for the page it is given, 100 at a time by default", async () => {
    const { fetch, calls } = respond(200, { data: [] });
    await fetchIsins(ERICSSON, { fetch, page: 4 });
    expect(calls).toEqual([
      `https://api.gleif.org/api/v1/lei-records/${ERICSSON}/isins?page%5Bsize%5D=100&page%5Bnumber%5D=4`,
    ]);
  });

  test("throws not-found for an unknown LEI", async () => {
    const { fetch } = respond(404, "");
    await expect(fetchIsins("549300W9JLPW15XIFM99", { fetch })).rejects.toMatchObject({
      kind: "not-found",
    });
  });
});

describe("lookups", () => {
  test("findByIsin returns summaries", async () => {
    const { fetch } = replay("lookup-isin");
    const page = await findByIsin("SE0000108656", { fetch });
    expect(page).toEqual({
      items: [
        {
          lei: ERICSSON,
          legalName: "Telefonaktiebolaget LM Ericsson",
          country: "SE",
          jurisdiction: "SE",
          registrationAuthorityId: "RA000544",
          registerNumber: "556016-0680",
          entityStatus: "ACTIVE",
          registrationStatus: "ISSUED",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
      pageCount: 1,
      goldenCopyDate: "2026-09-30T08:00:00Z",
    });
  });

  test("findByIsin returns an empty page when nothing matches", async () => {
    const page = await findByIsin("ZZ0000108656", { fetch: replay("lookup-no-hits").fetch });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  test("findByIsin trims the input", async () => {
    const { fetch } = replay("lookup-isin");
    await expect(findByIsin(" SE0000108656\n", { fetch })).resolves.toBeDefined();
  });

  test("findByBic looks an 8-character BIC up as its primary office", async () => {
    // The recorded request is for TOMCJP22XXX; replay fails on any other URL.
    const page = await findByBic("TOMCJP22", { fetch: replay("lookup-bic").fetch });
    expect(page.items.map((hit) => hit.lei)).toEqual(["5493006W3QUS5LMH6R84"]);
    expect(page.items[0]?.legalName).toBe("トヨタ自動車株式会社");
  });

  test("findByBic keeps an 11-character BIC as it is", async () => {
    const { fetch } = replay("lookup-bic");
    await expect(findByBic("TOMCJP22XXX", { fetch })).resolves.toMatchObject({ total: 1 });
    const other = respond(200, { data: [] });
    await findByBic("DEUTGB2LCLS", { fetch: other.fetch });
    expect(other.calls[0]).toContain("filter%5Bbic%5D=DEUTGB2LCLS&");
  });

  test("findByRegisterNumber returns every entity with the number", async () => {
    const { fetch } = replay("lookup-register-number");
    const page = await findByRegisterNumber("HRB 30000", { fetch, pageSize: 3 });
    expect(page.total).toBe(3);
    // Same number, three registers.
    expect(page.items.map((hit) => hit.registrationAuthorityId)).toEqual([
      "RA000302",
      "RA000354",
      "RA000242",
    ]);
    expect(page.items.every((hit) => hit.registerNumber === "HRB 30000")).toBe(true);
  });

  test("findByRegisterNumber puts exact matches first, ignoring case", async () => {
    const { fetch } = replay("lookup-register-number", (body) => {
      const document = body as { data: { attributes: { entity: { registeredAs: string } } }[] };
      const [first, second, third] = document.data;
      if (first) first.attributes.entity.registeredAs = "HRB 30000-A";
      if (second) second.attributes.entity.registeredAs = "hrb 30000";
      if (third) third.attributes.entity.registeredAs = "30000 HRB";
      return document;
    });
    // The fixture was recorded with the same URL, so the request still matches.
    const page = await findByRegisterNumber("HRB 30000", { fetch, pageSize: 3 });
    expect(page.items.map((hit) => hit.registerNumber)).toEqual([
      "hrb 30000",
      "HRB 30000-A",
      "30000 HRB",
    ]);
  });

  test("sends the filter GLEIF expects and the page it is given", async () => {
    const isin = respond(200, { data: [] });
    const register = respond(200, { data: [] });
    await findByIsin("SE0000108656", { fetch: isin.fetch, page: 2, pageSize: 5 });
    await findByRegisterNumber("556016-0680", { fetch: register.fetch });
    expect(isin.calls).toEqual([
      "https://api.gleif.org/api/v1/lei-records?filter%5Bisin%5D=SE0000108656&page%5Bsize%5D=5&page%5Bnumber%5D=2",
    ]);
    expect(register.calls).toEqual([
      "https://api.gleif.org/api/v1/lei-records?filter%5Bentity.registeredAs%5D=556016-0680&page%5Bsize%5D=10&page%5Bnumber%5D=1",
    ]);
  });

  test("skips hits without a LEI or name", async () => {
    const { fetch } = replay("lookup-isin", (body) => {
      const document = body as { data: unknown[] };
      document.data.push({ type: "lei-records", attributes: {} });
      return document;
    });
    const page = await findByIsin("SE0000108656", { fetch });
    expect(page.items).toHaveLength(1);
  });
});

describe("fetchNames", () => {
  const LOU = "549300O897ZC5H7CY412";
  const hit = (lei: string, name: string) => ({
    type: "lei-records",
    id: lei,
    attributes: { lei, entity: { legalName: { name } } },
  });

  test("gives the legal names of several LEIs in one request", async () => {
    // The recorded request names both LEIs; replay fails on any other URL.
    const { fetch, calls } = replay("lookup-names");
    const names = await fetchNames([ERICSSON, LOU], { fetch });
    expect(calls).toHaveLength(1);
    expect(names).toEqual(
      new Map([
        [ERICSSON, "Telefonaktiebolaget LM Ericsson"],
        [LOU, "Nordic Legal Entity Identifier AB"],
      ]),
    );
  });

  test("asks for each LEI once, with a page as big as the list", async () => {
    const { fetch, calls } = respond(200, { data: [] });
    await fetchNames([ERICSSON, LOU, ERICSSON], { fetch });
    expect(calls).toEqual([
      `https://api.gleif.org/api/v1/lei-records?filter%5Blei%5D=${ERICSSON}%2C${LOU}&page%5Bsize%5D=2`,
    ]);
  });

  test("leaves out an LEI GLEIF does not have, and anything it was not asked for", async () => {
    const { fetch } = respond(200, {
      data: [hit(ERICSSON, "Ericsson"), hit("549300ZZZZZZZZZZZZ46", "Other")],
    });
    const names = await fetchNames([ERICSSON, LOU], { fetch });
    expect([...names]).toEqual([[ERICSSON, "Ericsson"]]);
  });

  test("makes no request for no LEIs", async () => {
    const { fetch, calls } = respond(200, { data: [] });
    expect(await fetchNames([], { fetch })).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  test("asks about at most 200 LEIs, GLEIF's largest page", async () => {
    const { fetch, calls } = respond(200, { data: [] });
    const many = Array.from({ length: 250 }, (_, i) => `LEI${String(i).padStart(17, "0")}`);
    await fetchNames(many, { fetch });
    const url = new URL(calls[0] ?? "");
    expect(url.searchParams.get("filter[lei]")?.split(",")).toHaveLength(200);
    expect(url.searchParams.get("page[size]")).toBe("200");
  });

  test("fails like the other calls: a rate limit, or a body that is not a list", async () => {
    const busy = respond(429, "", { "retry-after": "30" });
    await expect(fetchNames([ERICSSON], { fetch: busy.fetch })).rejects.toMatchObject({
      kind: "rate-limited",
      retryAfter: 30,
    });
    const odd = respond(200, { data: null });
    await expect(fetchNames([ERICSSON], { fetch: odd.fetch })).rejects.toMatchObject({
      kind: "failed",
    });
  });
});

describe("errors", () => {
  test("404 is not-found, also for the recorded response", async () => {
    const { fetch } = replay("record-not-found");
    const error = await fetchRecord("549300W9JLPW15XIFM99", { fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GleifError);
    expect(error).toMatchObject({ kind: "not-found", status: 404, retryAfter: null });
  });

  test("404 is not-found when GLEIF answers with its HTML page", async () => {
    const { fetch } = respond(404, "<!DOCTYPE html><title>Not Found</title>");
    await expect(fetchRecord(ERICSSON, { fetch })).rejects.toMatchObject({ kind: "not-found" });
  });

  test("429 is rate-limited, with Retry-After in seconds", async () => {
    const { fetch } = respond(429, "", { "retry-after": "17" });
    await expect(fetchRecord(ERICSSON, { fetch })).rejects.toMatchObject({
      kind: "rate-limited",
      status: 429,
      retryAfter: 17,
    });
  });

  test("429 without Retry-After has a null retryAfter", async () => {
    const { fetch } = respond(429, "");
    await expect(findByIsin("SE0000108656", { fetch })).rejects.toMatchObject({
      kind: "rate-limited",
      retryAfter: null,
    });
  });

  test("another status is a failure that carries the status and GLEIF's title", async () => {
    const body = { errors: [{ title: "Include paths should contain only allowed ones." }] };
    const { fetch } = respond(400, body);
    const error = await fetchRecord(ERICSSON, { fetch }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "failed", status: 400 });
    expect((error as GleifError).message).toContain("Include paths should contain only allowed");
  });

  test("a server error is a failure", async () => {
    const { fetch } = respond(503, "Service Unavailable");
    await expect(fetchRecord(ERICSSON, { fetch })).rejects.toMatchObject({
      kind: "failed",
      status: 503,
    });
  });

  test("a network error is a failure, with the cause kept", async () => {
    const cause = new TypeError("fetch failed");
    const error = await fetchRecord(ERICSSON, {
      fetch: () => Promise.reject(cause),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "failed", status: null });
    expect((error as GleifError).cause).toBe(cause);
  });

  test("a body that is not JSON is a failure", async () => {
    const { fetch } = respond(200, "<html>maintenance</html>");
    await expect(fetchRecord(ERICSSON, { fetch })).rejects.toMatchObject({
      kind: "failed",
      status: 200,
    });
  });

  test("JSON that is not a record is a failure", async () => {
    const { fetch } = respond(200, { data: null });
    await expect(fetchRecord(ERICSSON, { fetch })).rejects.toMatchObject({ kind: "failed" });
    const lookup = respond(200, { meta: {} });
    await expect(findByIsin("SE0000108656", { fetch: lookup.fetch })).rejects.toMatchObject({
      kind: "failed",
    });
  });

  test("passes the signal on and lets an abort through unchanged", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    const fetch = (_url: string, init?: RequestInit) => {
      seen = init?.signal;
      return Promise.reject(controller.signal.reason);
    };
    controller.abort();
    const error = await fetchRecord(ERICSSON, { fetch, signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(seen).toBe(controller.signal);
    expect(error).not.toBeInstanceOf(GleifError);
    expect((error as Error).name).toBe("AbortError");
  });
});
