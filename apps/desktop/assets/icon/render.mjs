// Conduit mark: vector master + dependency-free rasterizer.
//
// Run:  node render.mjs        (Node >= 20, no packages needed)
//
// Writes, next to this script:
//   svg/*.svg            vector masters, one per variant
//   png/<variant>-<n>.png  rasters at 16..1024
//   conduit.ico          multi-size Windows icon (16..256) of the "app" variant
//   sheet.png            contact sheet on dark + light backgrounds
//   preview.html         the same, for a browser
//
// Geometry was measured off the chosen 1024px source image and normalized
// (the source ring sat ~9px above center). All units are in a 1024x1024 design
// space; every size is rendered from the same numbers, so nothing drifts between
// the SVG and the bitmaps.

import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- spec

export const COLORS = {
  navy: "#032555", // tile, sampled from source (3,37,85)
  white: "#FFFFFF", // brand ring
  copper: "#BF5935", // brand bar, sampled from source (191,89,53)
  online: "#23A55A", // status tokens already used by tray.ts / Discord panels
  idle: "#F0B232",
  // A lighter tint of the Discord red #F23F43, which is only 3.98:1 (WCAG) on
  // the navy tile; this is 4.96:1, so the 16px ring still reads.
  down: "#FF5C5F",
};

export const GEOMETRY = {
  canvas: 1024,
  cx: 512,
  cy: 512,
  outerR: 345, // measured 343-346
  innerR: 193, // measured 193
  gapHalfDeg: 26, // the cut ends are radial, at +/-25.7 deg from 3 o'clock
  barX0: 626, // bar starts inside the ring's hollow...
  barX1: 890, // ...and overshoots the outer radius by ~33
  barThickness: 16, // source value; variants override (see below)
};

// Smallest on-screen bar thickness, in device pixels. Below this the status
// color stops reading, so small renders thicken the bar automatically.
const MIN_BAR_PX = 2;

/**
 * Variants.
 *   tile:  background color, or null for transparent
 *   ring:  ring (the "C") color
 *   bar:   bar color
 *   barThickness: in design units (1024 space)
 *   scale: mark scale about the center (tray glyphs crop tighter)
 */
export const VARIANTS = {
  app: { tile: COLORS.navy, ring: COLORS.white, bar: COLORS.copper, barThickness: 64, scale: 1 },
  // The tray icon (`statusVariant()` in src/conduit-mark.ts): ring and bar in the
  // status color on the navy tile, so the three states read apart at 16px.
  "status-online": statusVariant(COLORS.online),
  "status-idle": statusVariant(COLORS.idle),
  "status-down": statusVariant(COLORS.down),
  "glyph-online": glyphVariant(COLORS.online),
  "glyph-idle": glyphVariant(COLORS.idle),
  "glyph-down": glyphVariant(COLORS.down),
};

function statusVariant(color) {
  return { tile: COLORS.navy, ring: color, bar: color, barThickness: 64, scale: 1.12 };
}

function glyphVariant(color) {
  return { tile: null, ring: COLORS.white, bar: color, barThickness: 72, scale: 1.3 };
}

const SIZES = [16, 20, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 20, 24, 32, 48, 64, 128, 256];

/** Bar thickness actually used at a given pixel size (design units). */
export function effectiveBarThickness(v, size) {
  const minUnits = (MIN_BAR_PX * GEOMETRY.canvas) / size / v.scale;
  return Math.max(v.barThickness, minUnits);
}

// ---------------------------------------------------------------- SVG

const f = (n) => +n.toFixed(2);

export function toSvg(v, barThickness = v.barThickness) {
  const { canvas, cx, cy, outerR, innerR, gapHalfDeg, barX0, barX1 } = GEOMETRY;
  const a = (gapHalfDeg * Math.PI) / 180;
  const pt = (r, t) => `${f(cx + r * Math.cos(t))} ${f(cy + r * Math.sin(t))}`;
  // Ring = annulus minus the right-hand wedge. y points down, so +a is below
  // the axis; sweep clockwise the long way round from +a to -a.
  const ring =
    `M ${pt(outerR, a)} A ${outerR} ${outerR} 0 1 1 ${pt(outerR, -a)} ` +
    `L ${pt(innerR, -a)} A ${innerR} ${innerR} 0 1 0 ${pt(innerR, a)} Z`;
  const half = barThickness / 2;
  const mark =
    `<path fill="${v.ring}" d="${ring}"/>` +
    `<rect fill="${v.bar}" x="${barX0}" y="${f(cy - half)}" width="${barX1 - barX0}" height="${f(barThickness)}"/>`;
  const tile = v.tile ? `<rect width="${canvas}" height="${canvas}" fill="${v.tile}"/>` : "";
  const t =
    v.scale === 1
      ? mark
      : `<g transform="translate(${cx} ${cy}) scale(${v.scale}) translate(${-cx} ${-cy})">${mark}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas} ${canvas}" width="${canvas}" height="${canvas}">${tile}${t}</svg>\n`;
}

// ---------------------------------------------------------------- raster

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** Which color a design-space point is: 0 = tile/none, 1 = ring, 2 = bar. */
function classify(x, y, barHalf) {
  const { cx, cy, outerR, innerR, gapHalfDeg, barX0, barX1 } = GEOMETRY;
  if (x >= barX0 && x <= barX1 && Math.abs(y - cy) <= barHalf) return 2;
  const dx = x - cx;
  const dy = y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 > outerR * outerR || d2 < innerR * innerR) return 0;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return Math.abs(deg) < gapHalfDeg ? 0 : 1;
}

/** Render a variant to straight-alpha RGBA, supersampled. */
export function rasterize(v, size) {
  const { canvas, cx, cy } = GEOMETRY;
  const ss = size <= 64 ? 16 : size <= 256 ? 6 : 3;
  const barHalf = effectiveBarThickness(v, size) / 2;
  const tile = v.tile ? hex(v.tile) : null;
  const ring = hex(v.ring);
  const bar = hex(v.bar);
  const k = canvas / size;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          // canvas point -> mark space (undo the scale about the center)
          const X = (px + (sx + 0.5) / ss) * k;
          const Y = (py + (sy + 0.5) / ss) * k;
          const c = classify(cx + (X - cx) / v.scale, cy + (Y - cy) / v.scale, barHalf);
          const col = c === 1 ? ring : c === 2 ? bar : tile;
          if (col) {
            r += col[0];
            g += col[1];
            b += col[2];
            a += 1;
          }
        }
      }
      const i = (py * size + px) * 4;
      const n = ss * ss;
      out[i] = a ? Math.round(r / a) : 0;
      out[i + 1] = a ? Math.round(g / a) : 0;
      out[i + 2] = a ? Math.round(b / a) : 0;
      out[i + 3] = Math.round((255 * a) / n);
    }
  }
  return { size, w: size, h: size, data: out };
}

// ---------------------------------------------------------------- encoders

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng({ w, h, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** ICO with PNG-compressed entries (supported since Vista; fine for electron-builder). */
export function encodeIco(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.png)]);
}

// ---------------------------------------------------------------- contact sheet

function blank(w, h, bg) {
  const [r, g, b] = hex(bg);
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, 255], i * 4);
  return { w, h, data };
}
function blit(dst, img, x0, y0, zoom = 1) {
  for (let y = 0; y < img.h * zoom; y++) {
    for (let x = 0; x < img.w * zoom; x++) {
      const s = (Math.floor(y / zoom) * img.w + Math.floor(x / zoom)) * 4;
      const d = ((y0 + y) * dst.w + (x0 + x)) * 4;
      const a = img.data[s + 3] / 255;
      for (let c = 0; c < 3; c++)
        dst.data[d + c] = Math.round(img.data[s + c] * a + dst.data[d + c] * (1 - a));
    }
  }
}

// ---------------------------------------------------------------- main

function main() {
  for (const d of ["svg", "png"]) mkdirSync(join(OUT, d), { recursive: true });
  const rendered = {};
  for (const [name, v] of Object.entries(VARIANTS)) {
    writeFileSync(join(OUT, "svg", `conduit-${name}.svg`), toSvg(v));
    rendered[name] = {};
    for (const size of SIZES) {
      const img = rasterize(v, size);
      rendered[name][size] = img;
      writeFileSync(join(OUT, "png", `conduit-${name}-${size}.png`), encodePng(img));
    }
  }
  writeFileSync(
    join(OUT, "conduit.ico"),
    encodeIco(ICO_SIZES.map((size) => ({ size, png: encodePng(rendered.app[size]) }))),
  );

  // Discord bot avatar: the opaque 1024px app tile (Discord crops it to a circle;
  // the whole mark sits within radius ~378 of center, well inside the 512 crop).
  mkdirSync(join(OUT, "discord"), { recursive: true });
  writeFileSync(join(OUT, "discord", "conduit-bot-avatar.png"), encodePng(rendered.app[1024]));
  // Preview of the circle crop at profile (128) and chat (40) sizes on Discord's
  // dark and light message backgrounds.
  const circle = (img) => {
    const out = { w: img.w, h: img.h, data: Buffer.from(img.data) };
    const c = (img.w - 1) / 2;
    const r = img.w / 2;
    for (let y = 0; y < img.h; y++)
      for (let x = 0; x < img.w; x++) {
        const d = Math.hypot(x - c, y - c);
        const cov = Math.max(0, Math.min(1, r - d + 0.5));
        out.data[(y * img.w + x) * 4 + 3] = Math.round(img.data[(y * img.w + x) * 4 + 3] * cov);
      }
    return out;
  };
  const av = blank(2 * (128 + 40 + 72), 128 + 48, "#313338");
  blit(av, blank(128 + 40 + 72, 128 + 48, "#FFFFFF"), 128 + 40 + 72, 0);
  for (const xBase of [0, 128 + 40 + 72]) {
    blit(av, circle(rendered.app[128]), xBase + 24, 24);
    blit(av, circle(rasterize(VARIANTS.app, 40)), xBase + 24 + 128 + 24, 24 + 44);
  }
  writeFileSync(join(OUT, "discord", "avatar-preview.png"), encodePng(av));

  // Sheet: per variant one row: 256, 64, 32, 24, 16, and 16 zoomed x8.
  const cols = [256, 64, 32, 24, 16];
  const zoom = 8;
  const gap = 24;
  const rowH = 256 + gap;
  const panelW = cols.reduce((s, c) => s + c + gap, gap) + 16 * zoom + gap;
  const names = Object.keys(VARIANTS);
  const sheetH = names.length * rowH + gap;
  const sheet = blank(panelW * 2, sheetH, "#1F1F1F");
  const light = blank(panelW, sheetH, "#F3F3F3");
  blit(sheet, light, panelW, 0);
  for (const [p, xBase] of [
    [0, 0],
    [1, panelW],
  ]) {
    void p;
    names.forEach((name, row) => {
      let x = xBase + gap;
      const y = gap + row * rowH;
      for (const c of cols) {
        blit(sheet, rendered[name][c], x, y + (256 - c) / 2);
        x += c + gap;
      }
      blit(sheet, rendered[name][16], x, y + (256 - 16 * zoom) / 2, zoom);
    });
  }
  writeFileSync(join(OUT, "sheet.png"), encodePng(sheet));

  const row = (name) =>
    `<tr><th>${name}</th>${[256, 64, 32, 24, 16]
      .map(
        (s) =>
          `<td><img src="png/conduit-${name}-${s === 256 ? 256 : s}.png" width="${s}" height="${s}"></td>`,
      )
      .join(
        "",
      )}<td><img class="px" src="png/conduit-${name}-16.png" width="128" height="128"></td></tr>`;
  const table = `<table>${Object.keys(VARIANTS).map(row).join("")}</table>`;
  writeFileSync(
    join(OUT, "preview.html"),
    `<!doctype html><meta charset="utf-8"><title>Conduit icon preview</title>
<style>body{margin:0;font:13px system-ui;display:flex}section{padding:16px 24px;flex:1}
.dark{background:#1f1f1f;color:#ddd}.light{background:#f3f3f3;color:#222}
td{padding:6px 10px;text-align:center;vertical-align:middle}th{text-align:left;font-weight:500;padding-right:12px}
img.px{image-rendering:pixelated}</style>
<section class="dark"><h3>Dark taskbar / surfaces</h3>${table}</section>
<section class="light"><h3>Light taskbar / surfaces</h3>${table}</section>
<section class="dark"><h3>Discord avatar (circle crop, 128 + 40)</h3><img src="discord/avatar-preview.png"></section>
<p style="position:fixed;bottom:8px;left:24px;color:#888">Columns: 256 · 64 · 32 · 24 · 16 · 16 zoomed 8x. Images are 1:1 device pixels only at 100% display scaling.</p>\n`,
  );
  console.log("wrote", OUT);
}

main();
