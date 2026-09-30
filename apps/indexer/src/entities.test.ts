import { describe, expect, test } from "vitest";
import { cleanName } from "./entities.ts";

describe("cleanName", () => {
  test("turns tabs and line breaks into spaces and strips the ends", () => {
    expect(cleanName("  Acme\tHoldings\r\nLtd \n")).toBe("Acme Holdings  Ltd");
  });

  test("strips what Python's str.strip() strips, and not what it keeps", () => {
    expect(cleanName(" 　Acme ")).toBe("Acme");
    expect(cleanName("\x1cAcme\x85")).toBe("Acme");
    // A zero-width no-break space is no whitespace to Python.
    expect(cleanName("﻿Acme")).toBe("﻿Acme");
  });

  test("leaves inner spacing alone", () => {
    expect(cleanName("A  B")).toBe("A  B");
    expect(cleanName("")).toBe("");
  });
});
