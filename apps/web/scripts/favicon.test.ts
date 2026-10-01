import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fullBleed, icoFile, lightSvg } from "./favicon.ts";

const read = (name: string) => readFileSync(new URL(`../static/${name}`, import.meta.url));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Width and height from the IHDR chunk of a PNG, and its colour type. */
const ihdr = (png: Buffer) => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
  colorType: png.readUInt8(25),
});

describe("lightSvg", () => {
  const svg = read("favicon.svg").toString("utf8");

  it("cuts the dark-theme block and nothing else", () => {
    expect(svg).toContain("@media (prefers-color-scheme:dark)");
    const light = lightSvg(svg);
    expect(light).not.toContain("@media");
    expect(light).not.toContain("#e4e4e1");
    expect(light).toContain(".t{fill:#17191e}.g{fill:#fbfbfc}.a{fill:#8db3ef}</style>");
    expect(light).toContain('<rect class="t" width="16" height="16" rx="3"/>');
  });

  it("refuses an @media block it cannot cut", () => {
    expect(() => lightSvg("<style>@media x{@media y{.a{fill:red}}}</style>")).toThrow();
  });
});

describe("fullBleed", () => {
  it("squares the tile, so it fills the image", () => {
    const out = fullBleed(read("favicon.svg").toString("utf8"));
    expect(out).toContain('width="16" height="16" rx="0"');
    expect(out).not.toContain('rx="3"');
  });

  it("refuses an SVG with no rounded tile", () => {
    expect(() => fullBleed("<svg/>")).toThrow();
  });
});

describe("icoFile", () => {
  it("writes the directory, one entry per image, and the images after it", () => {
    const a = Buffer.concat([PNG, Buffer.from("aa")]);
    const b = Buffer.concat([PNG, Buffer.from("bbbb")]);
    const ico = icoFile([
      { size: 16, png: a },
      { size: 256, png: b },
    ]);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    const entry = (i: number) => {
      const at = 6 + 16 * i;
      return {
        width: ico.readUInt8(at),
        height: ico.readUInt8(at + 1),
        planes: ico.readUInt16LE(at + 4),
        bits: ico.readUInt16LE(at + 6),
        length: ico.readUInt32LE(at + 8),
        offset: ico.readUInt32LE(at + 12),
      };
    };
    expect(entry(0)).toEqual({
      width: 16,
      height: 16,
      planes: 1,
      bits: 32,
      length: a.length,
      offset: 38,
    });
    // 256 is written as 0.
    expect(entry(1)).toEqual({
      width: 0,
      height: 0,
      planes: 1,
      bits: 32,
      length: b.length,
      offset: 38 + a.length,
    });
    expect(ico.subarray(38, 38 + a.length)).toEqual(a);
    expect(ico.length).toBe(38 + a.length + b.length);
  });
});

describe("the committed icons", () => {
  it("favicon.ico holds PNG images of 16, 32 and 48 px", () => {
    const ico = read("favicon.ico");
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    for (const [i, size] of [16, 32, 48].entries()) {
      const at = 6 + 16 * i;
      expect(ico.readUInt8(at)).toBe(size);
      const png = ico.subarray(
        ico.readUInt32LE(at + 12),
        ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8),
      );
      expect(png.subarray(0, 8)).toEqual(PNG);
      expect(ihdr(png)).toMatchObject({ width: size, height: size, colorType: 6 });
    }
  });

  it("the touch icon and the share image are opaque squares: no alpha channel", () => {
    // Colour type 2 is RGB; 6 would be RGBA.
    expect(ihdr(read("apple-touch-icon.png"))).toEqual({ width: 180, height: 180, colorType: 2 });
    expect(ihdr(read("icon-512.png"))).toEqual({ width: 512, height: 512, colorType: 2 });
  });
});
