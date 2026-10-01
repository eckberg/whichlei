// Record the API responses the tests replay into fixtures/. Run by hand, not in CI. It calls
// GLEIF through this package's own client, so the requests are the ones the client sends.
// One request per second keeps it well under GLEIF's limit of about 60 a minute.
//
//   pnpm --filter @whichlei/gleif record
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type Fetch,
  fetchIsins,
  fetchNames,
  fetchRecord,
  findByBic,
  findByIsin,
  findByRegisterNumber,
  type GleifOptions,
} from "../src/index.ts";

const ERICSSON = "549300W9JLPW15XIFM52";

const cases: [name: string, run: (options: GleifOptions) => Promise<unknown>][] = [
  ["record-ericsson", (o) => fetchRecord(ERICSSON, o)],
  // Both parents reported. Its parent is Ericsson.
  ["record-subsidiary", (o) => fetchRecord("98450057EFE9D01O5335", o)],
  ["record-fund", (o) => fetchRecord("2549006ZR9L6XM2MCE35", o)],
  // Registration LAPSED, entity still ACTIVE.
  ["record-lapsed", (o) => fetchRecord("9845006B0E5096QB7036", o)],
  ["record-branch", (o) => fetchRecord("636700XQVY1M7XLO8T61", o)],
  // INACTIVE, with a successor.
  ["record-retired", (o) => fetchRecord("984500F6D5C0F4FH0992", o)],
  // Japanese legal name, English alternative-language name.
  ["record-toyota", (o) => fetchRecord("5493006W3QUS5LMH6R84", o)],
  // Transliterated name.
  ["record-transliterated", (o) => fetchRecord("529900E3CDUZL6H6GX76", o)],
  // Exception reason NATURAL_PERSONS.
  ["record-exception", (o) => fetchRecord("894500VYHF8PY754L456", o)],
  ["record-not-found", (o) => fetchRecord("549300W9JLPW15XIFM99", o)],
  ["isins-ericsson", (o) => fetchIsins(ERICSSON, { ...o, pageSize: 3 })],
  ["lookup-isin", (o) => findByIsin("SE0000108656", o)],
  // An 8-character BIC, stored as TOMCJP22XXX.
  ["lookup-bic", (o) => findByBic("TOMCJP22", o)],
  // Three entities, in three registers.
  ["lookup-register-number", (o) => findByRegisterNumber("HRB 30000", { ...o, pageSize: 3 })],
  ["lookup-no-hits", (o) => findByIsin("ZZ0000108656", o)],
  // Two LEIs in one request: Ericsson and its managing LOU.
  ["lookup-names", (o) => fetchNames([ERICSSON, "549300O897ZC5H7CY412"], o)],
];

const only = process.argv.slice(2);
for (const [name, run] of cases) {
  if (only.length > 0 && !only.includes(name)) continue;
  let captured: object | undefined;
  const recorder: Fetch = async (url, init) => {
    const response = await fetch(url, init);
    const text = await response.clone().text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // The 404 page is HTML. Keep it as text.
    }
    captured = {
      url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      recorded: new Date().toISOString().slice(0, 10),
      body,
    };
    return response;
  };
  try {
    await run({ fetch: recorder });
  } catch (error) {
    if (!name.endsWith("not-found")) throw error;
  }
  const file = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
  writeFileSync(file, `${JSON.stringify(captured, null, 2)}\n`);
  console.log(name);
  await sleep(1000);
}
