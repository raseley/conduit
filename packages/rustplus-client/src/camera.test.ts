import { describe, expect, it } from "vitest";

import {
  IndexGenerator,
  buildSamplePositionBuffer,
  decodeRays,
  encodeFrameToPng,
} from "./camera.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Read a big-endian uint32 from a buffer at offset. */
function readU32(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0
  );
}

describe("IndexGenerator", () => {
  it("is deterministic for a given seed", () => {
    const a = new IndexGenerator(1337);
    const b = new IndexGenerator(1337);
    const seqA = Array.from({ length: 16 }, () => a.nextInt(100));
    const seqB = Array.from({ length: 16 }, () => b.nextInt(100));
    expect(seqA).toEqual(seqB);
  });

  it("produces values within [0, max)", () => {
    const gen = new IndexGenerator(42);
    for (let i = 0; i < 1000; i++) {
      const v = gen.nextInt(64);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(64);
    }
  });
});

describe("buildSamplePositionBuffer", () => {
  it("is a permutation of every (x, y) coordinate", () => {
    const w = 4;
    const h = 4;
    const buf = buildSamplePositionBuffer(w, h);
    expect(buf.length).toBe(w * h * 2);

    const seen = new Set<string>();
    for (let i = 0; i < buf.length; i += 2) {
      const x = buf[i];
      const y = buf[i + 1];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(w);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(h);
      seen.add(`${x},${y}`);
    }
    expect(seen.size).toBe(w * h);
  });

  it("caches by dimensions (stable across calls)", () => {
    expect(buildSamplePositionBuffer(8, 8)).toBe(buildSamplePositionBuffer(8, 8));
  });
});

describe("decodeRays", () => {
  // A 1×1 frame has no shuffle (buffer = [0, 0]), so a single full-sample ray
  // lands at pixel 0 — letting us hand-verify the decode + colorize math.
  it("decodes a full-sample ray into the sky sentinel", () => {
    // n=0xFF (full sample); t=(255<<2)|(192>>6)=1023, r=63&192=0, material=0.
    const buf = buildSamplePositionBuffer(1, 1);
    const out = decodeRays(
      [{ sampleOffset: 0, rayData: new Uint8Array([255, 255, 192, 0]) }],
      buf,
      1,
      1,
    );
    expect(out[0]).toEqual([1, 0, 0]);
  });

  it("decodes a full-sample ray into a material colour", () => {
    // t=(100<<2)|0=400, r=63&63=63 → alignment 1, material=6.
    const buf = buildSamplePositionBuffer(1, 1);
    const out = decodeRays(
      [{ sampleOffset: 0, rayData: new Uint8Array([255, 100, 63, 6]) }],
      buf,
      1,
      1,
    );
    expect(out[0]).toEqual([400 / 1023, 1, 6]);
  });

  it("a repeat-mode ray reuses the prior lookback entry", () => {
    // Full sample then a repeat (mode 0b00, lookback index = hash of that sample).
    // The full sample hashes to slot u; a repeat byte = u re-emits it.
    const buf = buildSamplePositionBuffer(2, 1);
    // First ray: t=400, r=63, i=6 → u = (3*floor(400/128)+5*floor(63/16)+7*6)&63
    //                              = (3*3 + 5*3 + 42) & 63 = (9+15+42)&63 = 66&63 = 2.
    const u = 2;
    // Trailing 0 is a guard byte: the decode loop stops before its final byte, so
    // the repeat byte `u` must not be last or it would never be read.
    const out = decodeRays(
      [{ sampleOffset: 0, rayData: new Uint8Array([255, 100, 63, 6, u, 0]) }],
      buf,
      2,
      1,
    );
    // Both pixels (offsets 0 and 1) decode to the same sample.
    expect(out[0]).toEqual([400 / 1023, 1, 6]);
    expect(out[1]).toEqual([400 / 1023, 1, 6]);
  });
});

describe("encodeFrameToPng", () => {
  it("emits a valid PNG with the requested dimensions", async () => {
    const out = new Array(8 * 8);
    const png = await encodeFrameToPng(out, 8, 8);
    expect(Array.from(png.slice(0, 8))).toEqual(PNG_SIGNATURE);
    // IHDR width/height are the big-endian u32s at byte offsets 16 and 20.
    expect(readU32(png, 16)).toBe(8);
    expect(readU32(png, 20)).toBe(8);
  });

  it("renders the sky sentinel pixel as the fixed sky colour (Y-flipped)", async () => {
    const buf = buildSamplePositionBuffer(1, 1);
    const out = decodeRays(
      [{ sampleOffset: 0, rayData: new Uint8Array([255, 255, 192, 0]) }],
      buf,
      1,
      1,
    );
    const bytes = await encodeFrameToPng(out, 1, 1);
    const { PNG } = await import("pngjs");
    const decoded = PNG.sync.read(Buffer.from(bytes));
    expect(Array.from(decoded.data.slice(0, 4))).toEqual([208, 230, 252, 255]);
  });

  it("renders a material ray as alignment-scaled RGB", async () => {
    const buf = buildSamplePositionBuffer(1, 1);
    const out = decodeRays(
      [{ sampleOffset: 0, rayData: new Uint8Array([255, 100, 63, 6]) }],
      buf,
      1,
      1,
    );
    const bytes = await encodeFrameToPng(out, 1, 1);
    const { PNG } = await import("pngjs");
    const decoded = PNG.sync.read(Buffer.from(bytes));
    // material 6 = [1, 0.4, 0.4], alignment 1 → [255, 102, 102, 255].
    expect(Array.from(decoded.data.slice(0, 4))).toEqual([255, 102, 102, 255]);
  });
});
