// Renders the favicon's other formats from static/favicon.svg, the one source:
//
//   PW_CHROMIUM=/path/to/chrome node scripts/favicon.ts      (or: pnpm favicon)
//
// Writes into static/, and the results are committed, so a build needs no browser:
//   favicon.ico         16, 32 and 48 px in one file, with the corners of the tile
//   apple-touch-icon.png  180 px, full bleed and opaque (iOS rounds it itself)
//   icon-512.png        512 px, the same, for og:image
// All in the light colours: the dark theme is the SVG's own business (an @media block).
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The SVG without its dark-theme block: what a format without a colour scheme gets. */
export function lightSvg(svg: string): string {
  const light = svg.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/, "");
  if (light.includes("@media")) throw new Error("favicon.svg has an @media block this cannot cut");
  return light;
}

/** The tile with square corners, so it fills the whole image. */
export function fullBleed(svg: string): string {
  if (!svg.includes('rx="3"')) throw new Error('favicon.svg has no rx="3" tile to square');
  return svg.replace('rx="3"', 'rx="0"');
}

/**
 * An .ico file holding PNG images (valid since Vista; every browser reads it): the 6-byte
 * ICONDIR, one 16-byte ICONDIRENTRY per image, then the images.
 */
export function icoFile(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    // Width and height are one byte each, where 0 means 256.
    header.writeUInt8(size === 256 ? 0 : size, at);
    header.writeUInt8(size === 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

async function main(): Promise<void> {
  // Loaded here, so the tests of the functions above do not load a browser library.
  const { chromium } = await import("@playwright/test");
  const statics = new URL("../static/", import.meta.url);
  const svg = readFileSync(new URL("favicon.svg", statics), "utf8");
  const light = lightSvg(svg);
  const bleed = fullBleed(light);

  const browser = await chromium.launch({
    ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
  });
  try {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();
    const render = async (markup: string, size: number, opaque: boolean): Promise<Buffer> => {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`,
      );
      return page.screenshot({ type: "png", omitBackground: !opaque });
    };
    // One at a time: they share the page and its viewport.
    const images: { size: number; png: Buffer }[] = [];
    for (const size of [16, 32, 48]) images.push({ size, png: await render(light, size, false) });
    writeFileSync(new URL("favicon.ico", statics), icoFile(images));
    writeFileSync(new URL("apple-touch-icon.png", statics), await render(bleed, 180, true));
    writeFileSync(new URL("icon-512.png", statics), await render(bleed, 512, true));
  } finally {
    await browser.close();
  }
  console.log("wrote favicon.ico, apple-touch-icon.png and icon-512.png into static/");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
