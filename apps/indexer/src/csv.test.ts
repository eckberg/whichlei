import { describe, expect, test } from "vitest";
import { CsvParser, columnsOf, parseCsv, parseCsvStream } from "./csv.ts";

describe("csv", () => {
  test("reads plain fields and rows", () => {
    expect(parseCsv("a,b,c\n1,2,3\n4,5,6\n")).toEqual({
      header: ["a", "b", "c"],
      rows: [
        ["1", "2", "3"],
        ["4", "5", "6"],
      ],
    });
  });

  test("reads quoted fields with commas, doubled quotes and line breaks", () => {
    const { rows } = parseCsv('a,b\n"x, y","say ""hi"""\n"two\nlines","a\r\nb"\n');
    expect(rows).toEqual([
      ["x, y", 'say "hi"'],
      ["two\nlines", "a\r\nb"],
    ]);
  });

  test("reads CRLF, a lone CR, and a last row without a line break", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4\r5,6").rows).toEqual([
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
  });

  test("keeps empty fields, and skips empty lines", () => {
    expect(parseCsv('a,b,c\n,"",x\n\n,,\n1,2,\n').rows).toEqual([
      ["", "", "x"],
      ["", "", ""],
      ["1", "2", ""],
    ]);
  });

  test("reads a quote inside an unquoted field as a character, as Python's csv does", () => {
    expect(parseCsv('a,b\n5" pipe,x\n"ab"cd,y\n').rows).toEqual([
      ['5" pipe', "x"],
      ["abcd", "y"],
    ]);
  });

  test("pads a short row with empty fields", () => {
    expect(parseCsv("a,b,c\n1\n").rows).toEqual([["1", "", ""]]);
  });

  test("decodes UTF-8 and drops a byte order mark from the header", () => {
    const { header, rows } = parseCsv("﻿LEI,name\n1,Mærsk Ølsen 日本\n");
    expect(header).toEqual(["LEI", "name"]);
    expect(rows).toEqual([["1", "Mærsk Ølsen 日本"]]);
  });

  test("skips a byte order mark, also in front of a quote and also when cut into chunks", () => {
    const text = '\uFEFF"LEI","name"\r\n"1","x"\r\n';
    const expected = { header: ["LEI", "name"], rows: [["1", "x"]] };
    expect(parseCsv(text)).toEqual(expected);
    const bytes = Buffer.from(text, "utf8");
    for (const size of [1, 2, 3, 4]) {
      const rows: string[][] = [];
      let header: string[] = [];
      const parser = new CsvParser((row) => rows.push([...row]), {
        onHeader: (h) => {
          header = h;
          return undefined;
        },
      });
      for (let i = 0; i < bytes.length; i += size) parser.write(bytes.subarray(i, i + size));
      parser.end();
      expect({ header, rows }, `chunks of ${size}`).toEqual(expected);
    }
    // A file shorter than a byte order mark is still read.
    expect(parseCsv("a\n1").rows).toEqual([["1"]]);
    expect(parseCsv("").rows).toEqual([]);
  });

  test("decodes only the selected columns", () => {
    const { rows } = parseCsv("a,b,c,d\n1,2,3,4\n5,6,7,8\n", {
      onHeader: (header) => [header.indexOf("b"), header.indexOf("d")],
    });
    expect(rows).toEqual([
      ["", "2", "", "4"],
      ["", "6", "", "8"],
    ]);
  });

  test("skips a selected-out column that holds quotes and line breaks", () => {
    const { rows } = parseCsv('a,b,c\n"x\n""y""",2,3\n', { onHeader: () => [2] });
    expect(rows).toEqual([["", "", "3"]]);
  });

  test("gives the same rows however the input is cut into chunks", () => {
    const text =
      'LEI,name,note\r\n1,"Ærø, ""Ltd""",\r\n2,"a\r\nb",x\r\n3,plain,"é"\r\n\r\n4,"","last"';
    const whole = parseCsv(text).rows;
    const bytes = Buffer.from(text, "utf8");
    for (const size of [1, 2, 3, 5, 7, 11]) {
      const rows: string[][] = [];
      const parser = new CsvParser((row) => rows.push([...row]));
      for (let i = 0; i < bytes.length; i += size) parser.write(bytes.subarray(i, i + size));
      parser.end();
      expect(rows, `chunks of ${size}`).toEqual(whole);
    }
    expect(whole).toEqual([
      ["1", 'Ærø, "Ltd"', ""],
      ["2", "a\r\nb", "x"],
      ["3", "plain", "é"],
      ["4", "", "last"],
    ]);
  });

  test("reads an unterminated quote to the end of the data", () => {
    expect(parseCsv('a,b\n1,"open').rows).toEqual([["1", "open"]]);
  });

  test("reads a stream of chunks", async () => {
    async function* chunks() {
      yield Buffer.from("a,b\n1,");
      yield Buffer.from("2\n3,4\n");
    }
    const rows: string[][] = [];
    await parseCsvStream(chunks(), (row) => rows.push([...row]));
    expect(rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("finds columns by name, and fails on a missing one", () => {
    expect(columnsOf(["x", "y", "z"], ["z", "x"])).toEqual({ z: 2, x: 0 });
    expect(() => columnsOf(["x"], ["y"])).toThrow(/"y" is missing/);
  });
});
