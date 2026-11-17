import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { describe, it, expect } from "vitest";

import {
  MARK_COLORS,
  appVariant,
  rasterizeMark,
  statusVariant,
  toBgra,
  type MarkBitmap,
  type MarkLevel,
} from "./conduit-mark.js";

/** The RGBA pixel at (x, y). */
function pixel(bitmap: MarkBitmap, x: number, y: number): number[] {
  const i = (y * bitmap.size + x) * 4;
  return [...bitmap.data.slice(i, i + 4)];
}

const opaque = (rgb: readonly number[]): number[] => [...rgb, 255];

/** WCAG 2 contrast ratio between two sRGB colors. */
function contrast(a: readonly number[], b: readonly number[]): number {
  const luminance = (rgb: readonly number[]): number => {
    const [r, g, b] = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * Decode a PNG written by `render.mjs`'s encoder: 8-bit RGBA, one IDAT, every
 * row with filter 0 (none). Not a general PNG decoder.
 */
function decodeGeneratorPng(file: string): MarkBitmap {
  const png = readFileSync(file);
  let offset = 8;
  let width = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") width = body.readUInt32BE(0);
    if (type === "IDAT") idat.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  const data = new Uint8Array(width * width * 4);
  for (let y = 0; y < width; y++) {
    expect(raw[y * stride]).toBe(0); // filter: none
    data.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * width * 4);
  }
  return { size: width, data };
}

describe("conduit-mark", () => {
  it("matches the generator: the app variant at 256px equals the shipped PNG", () => {
    const shipped = decodeGeneratorPng(
      join(import.meta.dirname, "..", "assets", "icon", "png", "conduit-app-256.png"),
    );
    const drawn = rasterizeMark(appVariant(), 256);
    expect(drawn.size).toBe(shipped.size);
    expect(Buffer.from(drawn.data).equals(Buffer.from(shipped.data))).toBe(true);
  });

  it.each<MarkLevel>(["online", "idle", "down"])(
    "the %s tray icon: status-colored ring and bar, navy gap and tile",
    (level) => {
      const icon = rasterizeMark(statusVariant(level), 32);
      // Middle of the bar, right of the ring's gap.
      expect(pixel(icon, 25, 15)).toEqual(opaque(MARK_COLORS[level]));
      expect(pixel(icon, 25, 16)).toEqual(opaque(MARK_COLORS[level]));
      // Inside the gap, below the bar: the tile shows through.
      expect(pixel(icon, 24, 18)).toEqual(opaque(MARK_COLORS.navy));
      // The ring's left side.
      expect(pixel(icon, 6, 15)).toEqual(opaque(MARK_COLORS[level]));
      // The ring's hollow, left of the bar.
      expect(pixel(icon, 12, 15)).toEqual(opaque(MARK_COLORS.navy));
      // A corner: the tile is full-bleed.
      expect(pixel(icon, 0, 0)).toEqual(opaque(MARK_COLORS.navy));
    },
  );

  it.each<MarkLevel>(["online", "idle", "down"])(
    "the %s tray icon colors the ring at 16px too, and no pixel is white",
    (level) => {
      const icon = rasterizeMark(statusVariant(level), 16);
      // The ring's left and top sides are fully covered at 16px.
      expect(pixel(icon, 3, 7)).toEqual(opaque(MARK_COLORS[level]));
      expect(pixel(icon, 7, 3)).toEqual(opaque(MARK_COLORS[level]));
      const pixels = Array.from({ length: 16 * 16 }, (_, i) => pixel(icon, i % 16, (i / 16) | 0));
      expect(pixels.some((p) => p.join() === opaque(MARK_COLORS.white).join())).toBe(false);
    },
  );

  it.each<MarkLevel>(["online", "idle", "down"])(
    "the %s color clears 4.5:1 (WCAG) against the navy tile",
    (level) => {
      expect(contrast(MARK_COLORS[level], MARK_COLORS.navy)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("leaves the brand variant's ring white", () => {
    const icon = rasterizeMark(appVariant(), 32);
    expect(pixel(icon, 7, 15)).toEqual(opaque(MARK_COLORS.white));
  });

  it("keeps the status color readable at 16px (the bar is thickened to 2px)", () => {
    const icon = rasterizeMark(statusVariant("down"), 16);
    const red = opaque(MARK_COLORS.down);
    // Columns 10–13 hold the bar, clear of the ring (the hollow and the gap).
    const barRows = Array.from({ length: 16 }, (_, y) => y).filter((y) =>
      [10, 11, 12, 13].every((x) => pixel(icon, x, y).join() === red.join()),
    );
    expect(barRows).toEqual([7, 8]);
  });

  it("toBgra swaps red and blue and keeps alpha", () => {
    const bitmap: MarkBitmap = { size: 1, data: new Uint8Array([1, 2, 3, 4]) };
    expect([...toBgra(bitmap)]).toEqual([3, 2, 1, 4]);
  });
});
