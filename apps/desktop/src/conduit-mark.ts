/**
 * The Conduit mark, rasterized in code: a ring with a radial gap at
 * 3 o'clock on a navy tile, with a bar running out through the gap.
 *
 * A port of `classify()` + `rasterize()` from `assets/icon/render.mjs` (the
 * generator of the shipped icon files), for the tray icon: its ring and bar
 * take the status color, so every level is drawn from the same numbers
 * rather than shipped as a file. Keep the geometry in step with `render.mjs`.
 *
 * Electron-free and pure, so it unit-tests like the rest of `apps/desktop`;
 * `windows/tray.ts` wraps the bitmaps in a `nativeImage`.
 */

/**
 * Colors, as RGB. `online` and `idle` are the tray/Discord status tokens.
 * `down` is a lighter tint of the Discord red `#F23F43`: on the navy tile that
 * red is only 3.98:1 (WCAG), below the 4.5:1 the 2–3px ring needs at 16px;
 * `#FF5C5F` is 4.96:1 and still reads as red (`online` is 4.72:1, `idle` 7.94:1).
 */
export const MARK_COLORS = {
  navy: [0x03, 0x25, 0x55],
  white: [0xff, 0xff, 0xff],
  copper: [0xbf, 0x59, 0x35],
  online: [0x23, 0xa5, 0x5a],
  idle: [0xf0, 0xb2, 0x32],
  down: [0xff, 0x5c, 0x5f],
} as const satisfies Record<string, readonly [number, number, number]>;

/** Geometry in a 1024×1024 design space (see `render.mjs`). */
export const MARK_GEOMETRY = {
  canvas: 1024,
  cx: 512,
  cy: 512,
  outerR: 345,
  innerR: 193,
  gapHalfDeg: 26,
  barX0: 626,
  barX1: 890,
} as const;

/** Smallest on-screen bar thickness, in device pixels, so the color still reads at 16px. */
const MIN_BAR_PX = 2;

/** A drawable variant of the mark. */
export interface MarkVariant {
  /** Background tile color, or `null` for transparent. */
  tile: readonly [number, number, number] | null;
  /** Ring (the "C") color. */
  ring: readonly [number, number, number];
  bar: readonly [number, number, number];
  /** Bar thickness in design units. */
  barThickness: number;
  /** Mark scale about the center. */
  scale: number;
}

/** The status level a tray icon shows. */
export type MarkLevel = "online" | "idle" | "down";

/**
 * The tray variant (`status-*` in `render.mjs`): navy tile, ring and bar both
 * in the status color, mark drawn 12% larger to fill a 16px tray slot.
 * Every level is colored, healthy too, so the three read apart at a glance; the
 * bar keeps the mark's shape and adds no second color to the 16px glyph. The
 * tile keeps the ring legible on Windows' light taskbar too.
 */
export function statusVariant(level: MarkLevel): MarkVariant {
  return {
    tile: MARK_COLORS.navy,
    ring: MARK_COLORS[level],
    bar: MARK_COLORS[level],
    barThickness: 64,
    scale: 1.12,
  };
}

/** The brand variant (`app` in `render.mjs`): navy tile, white ring, copper bar. */
export function appVariant(): MarkVariant {
  return {
    tile: MARK_COLORS.navy,
    ring: MARK_COLORS.white,
    bar: MARK_COLORS.copper,
    barThickness: 64,
    scale: 1,
  };
}

/** An RGBA bitmap, straight (non-premultiplied) alpha. */
export interface MarkBitmap {
  size: number;
  data: Uint8Array;
}

/** Bar thickness actually used at a pixel size (design units). */
function effectiveBarThickness(v: MarkVariant, size: number): number {
  const minUnits = (MIN_BAR_PX * MARK_GEOMETRY.canvas) / size / v.scale;
  return Math.max(v.barThickness, minUnits);
}

/** Which part a design-space point is in: 0 = tile/none, 1 = ring, 2 = bar. */
function classify(x: number, y: number, barHalf: number): 0 | 1 | 2 {
  const { cx, cy, outerR, innerR, gapHalfDeg, barX0, barX1 } = MARK_GEOMETRY;
  if (x >= barX0 && x <= barX1 && Math.abs(y - cy) <= barHalf) return 2;
  const dx = x - cx;
  const dy = y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 > outerR * outerR || d2 < innerR * innerR) return 0;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return Math.abs(deg) < gapHalfDeg ? 0 : 1;
}

/** Render a variant to an RGBA bitmap of `size`×`size`, supersampled. */
export function rasterizeMark(v: MarkVariant, size: number): MarkBitmap {
  const { canvas, cx, cy } = MARK_GEOMETRY;
  const ss = size <= 64 ? 16 : size <= 256 ? 6 : 3;
  const barHalf = effectiveBarThickness(v, size) / 2;
  const k = canvas / size;
  const data = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          // Canvas point → mark space (undo the scale about the center).
          const x = (px + (sx + 0.5) / ss) * k;
          const y = (py + (sy + 0.5) / ss) * k;
          const part = classify(cx + (x - cx) / v.scale, cy + (y - cy) / v.scale, barHalf);
          const color = part === 1 ? v.ring : part === 2 ? v.bar : v.tile;
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 1;
          }
        }
      }
      const i = (py * size + px) * 4;
      data[i] = a ? Math.round(r / a) : 0;
      data[i + 1] = a ? Math.round(g / a) : 0;
      data[i + 2] = a ? Math.round(b / a) : 0;
      data[i + 3] = Math.round((255 * a) / (ss * ss));
    }
  }
  return { size, data };
}

/**
 * The same bitmap in BGRA byte order, which Electron's
 * `nativeImage.createFromBuffer` expects for raw pixels.
 */
export function toBgra(bitmap: MarkBitmap): Uint8Array {
  const out = new Uint8Array(bitmap.data.length);
  for (let i = 0; i < bitmap.data.length; i += 4) {
    out[i] = bitmap.data[i + 2]!;
    out[i + 1] = bitmap.data[i + 1]!;
    out[i + 2] = bitmap.data[i]!;
    out[i + 3] = bitmap.data[i + 3]!;
  }
  return out;
}
