// A streaming CSV parser (RFC 4180) over bytes. The level 1 golden copy is about 3 GB of
// text in 3.4 million rows of 330 columns, so the parser scans bytes, decodes only the
// columns the caller selects, and never holds more than one partial record.
//
// It reads like Python's csv module, which the research used, so both see the same rows:
// quoted fields may hold commas, line breaks and doubled quotes; a quote inside an
// unquoted field is literal; text after a closing quote joins the field; empty lines are
// skipped; a row that ends early reads as if its missing fields were empty.

const QUOTE = 0x22;
const COMMA = 0x2c;
const CR = 0x0d;
const LF = 0x0a;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface CsvOptions {
  /**
   * Called once with the header row. Returns the columns to decode in the rows that
   * follow. The default is every column.
   */
  onHeader?: (header: string[]) => readonly number[] | undefined;
}

/**
 * Feed bytes with `write`, finish with `end`. `onRow` gets one array per data row, indexed
 * by column; the first row of the input is the header and is not passed on. Columns that
 * were not selected hold "". The array is reused: copy what you keep.
 */
export class CsvParser {
  #pending: Buffer | null = null;
  #bomChecked = false;
  #header: string[] | null = null;
  /** 1 for the columns to decode. */
  #wanted: Uint8Array = new Uint8Array(0);
  #row: string[] = [];
  readonly #onRow: (row: string[]) => void;
  readonly #options: CsvOptions;

  constructor(onRow: (row: string[]) => void, options: CsvOptions = {}) {
    this.#onRow = onRow;
    this.#options = options;
  }

  write(chunk: Uint8Array): void {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let buffer = this.#pending === null ? bytes : Buffer.concat([this.#pending, bytes]);
    this.#pending = null;
    if (!this.#bomChecked) {
      // Wait for three bytes: a byte order mark in front of the first quote is not data.
      if (buffer.length < BOM.length) {
        this.#pending = Buffer.from(buffer);
        return;
      }
      this.#bomChecked = true;
      if (buffer.subarray(0, BOM.length).equals(BOM)) buffer = buffer.subarray(BOM.length);
    }
    const used = this.#scan(buffer, false);
    if (used < buffer.length) this.#pending = Buffer.from(buffer.subarray(used));
  }

  end(): void {
    let buffer = this.#pending ?? Buffer.alloc(0);
    this.#pending = null;
    if (!this.#bomChecked) {
      this.#bomChecked = true;
      if (buffer.subarray(0, BOM.length).equals(BOM)) buffer = buffer.subarray(BOM.length);
    }
    this.#scan(buffer, true);
  }

  /** Parse whole records from `buffer`. Returns how many bytes it used. */
  #scan(buffer: Buffer, final: boolean): number {
    let position = 0;
    while (position < buffer.length) {
      const next = this.#record(buffer, position, final);
      if (next < 0) break;
      position = next;
    }
    return position;
  }

  /**
   * Parse the record that starts at `start`. Returns where the next one starts, or -1 if
   * the buffer ends inside this record and more bytes are needed.
   */
  #record(buffer: Buffer, start: number, final: boolean): number {
    const end = buffer.length;
    let p = start;
    // An empty line is no record.
    if (buffer[p] === LF) return p + 1;
    if (buffer[p] === CR) {
      if (p + 1 >= end && !final) return -1;
      return buffer[p + 1] === LF ? p + 2 : p + 1;
    }

    const isHeader = this.#header === null;
    const wanted = this.#wanted;
    const row = isHeader ? [] : this.#row;
    if (!isHeader) row.fill("");
    let column = 0;

    for (;;) {
      const take = isHeader || wanted[column] === 1;
      let fieldStart: number;
      let fieldEnd: number;
      let escaped = false;
      let tail = "";

      if (buffer[p] === QUOTE) {
        fieldStart = p + 1;
        let q = fieldStart;
        for (;;) {
          while (q < end && buffer[q] !== QUOTE) q++;
          if (q >= end) {
            if (!final) return -1;
            break; // an unterminated quote ends with the data
          }
          // Cannot tell a closing quote from the first of a doubled pair yet.
          if (q + 1 >= end && !final) return -1;
          if (buffer[q + 1] === QUOTE) {
            escaped = true;
            q += 2;
            continue;
          }
          break;
        }
        fieldEnd = q;
        p = q < end ? q + 1 : end;
        // Text after the closing quote belongs to the field, as in Python's csv.
        let t = p;
        while (t < end && buffer[t] !== COMMA && buffer[t] !== CR && buffer[t] !== LF) t++;
        if (t > p) {
          if (take) tail = buffer.toString("utf8", p, t);
          p = t;
        }
      } else {
        fieldStart = p;
        while (p < end && buffer[p] !== COMMA && buffer[p] !== CR && buffer[p] !== LF) p++;
        fieldEnd = p;
      }

      if (take) {
        let value = fieldEnd > fieldStart ? buffer.toString("utf8", fieldStart, fieldEnd) : "";
        if (escaped) value = value.replaceAll('""', '"');
        row[column] = tail === "" ? value : value + tail;
      }
      column++;

      // The record ends here, or another field follows.
      if (p >= end) {
        if (!final) return -1;
        break;
      }
      const c = buffer[p];
      if (c === COMMA) {
        p++;
        if (p >= end) {
          // A trailing comma: one more field, empty.
          if (!final) return -1;
          break;
        }
        continue;
      }
      if (c === CR) {
        if (p + 1 >= end && !final) return -1;
        p += buffer[p + 1] === LF ? 2 : 1;
      } else {
        p++;
      }
      break;
    }

    if (isHeader) this.#start(row);
    else this.#onRow(row);
    return p;
  }

  #start(header: string[]): void {
    this.#header = header;
    const columns = this.#options.onHeader?.(header);
    const width = Math.max(header.length, ...(columns ?? []).map((c) => c + 1));
    this.#wanted = new Uint8Array(width).fill(columns === undefined ? 1 : 0);
    for (const c of columns ?? []) this.#wanted[c] = 1;
    this.#row = new Array<string>(width).fill("");
  }
}

/** Parse a whole text, for small inputs: the code lists and tests. The header comes first. */
export function parseCsv(
  text: string | Uint8Array,
  options: CsvOptions = {},
): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let header: string[] = [];
  const parser = new CsvParser((row) => rows.push([...row]), {
    onHeader: (h) => {
      header = h;
      return options.onHeader?.(h);
    },
  });
  parser.write(typeof text === "string" ? Buffer.from(text, "utf8") : text);
  parser.end();
  return { header, rows };
}

/** Parse a stream of chunks, such as a child process's stdout. */
export async function parseCsvStream(
  source: AsyncIterable<Uint8Array>,
  onRow: (row: string[]) => void,
  options: CsvOptions = {},
): Promise<void> {
  const parser = new CsvParser(onRow, options);
  for await (const chunk of source) parser.write(chunk);
  parser.end();
}

/** Column indexes by header name. Throws on a missing name, so a format change is loud. */
export function columnsOf<const N extends string>(
  header: readonly string[],
  names: readonly N[],
): Record<N, number> {
  const out = {} as Record<N, number>;
  for (const name of names) {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`column "${name}" is missing from the header`);
    out[name] = i;
  }
  return out;
}
