/**
 * Camera frame rendering — decode Rust+ `AppCameraRays` broadcasts into a PNG.
 *
 * A Rust+ camera does not stream pixels: each `AppCameraRays` broadcast carries a
 * chunk of "rays" sampled in a pseudo-random, seed-shuffled order, each decoding to
 * `[distance, alignment, material]`. Accumulating several broadcasts fills the frame,
 * which is then colourised into a depth/material image (no entity overlays).
 *
 * The decode is a faithful port of liamcottle/rustplus.js `camera.js`
 * (`IndexGenerator` + `_renderCameraFrame`). The bit operations and the
 * sample-position shuffle must match the reference exactly or the image is garbage.
 *
 * Pure module: imports only `pngjs` (pure-JS, no native deps), operates on plain
 * primitives, and is independently unit-testable.
 */

/** One decoded ray frame, fed from an `AppCameraRays` broadcast. */
export interface CameraRayFrame {
  /** Where this chunk's samples land in the shuffled position buffer. */
  sampleOffset: number;
  /** Run-length/delta-encoded ray samples. */
  rayData: Uint8Array;
}

/** A decoded ray: `[distance 0..1, alignment 0..1, material index]`. */
type DecodedRay = [number, number, number];

/**
 * Seeded xorshift PRNG driving the Fisher–Yates shuffle of sample positions.
 * Ported verbatim from rustplus.js — including its quirks — so the produced
 * sequence is byte-identical to the game-side shuffle.
 */
export class IndexGenerator {
  private state: number;

  constructor(seed: number) {
    this.state = 0 | seed;
    this.nextState();
  }

  nextInt(max: number): number {
    let t = ((this.nextState() * (0 | max)) / 4294967295) | 0;
    if (t < 0) t = max + t - 1;
    return 0 | t;
  }

  nextState(): number {
    let e = this.state;
    const t = e;
    e = ((e = ((e = (e ^ ((e << 13) | 0)) | 0) ^ ((e >>> 17) | 0)) | 0) ^ ((e << 5) | 0)) | 0;
    this.state = e;
    return t >= 0 ? t : 4294967295 + t - 1;
  }
}

/** Material → base RGB (0..1) palette, multiplied by per-ray alignment for shading. */
const COLOURS: readonly (readonly [number, number, number])[] = [
  [0.5, 0.5, 0.5],
  [0.8, 0.7, 0.7],
  [0.3, 0.7, 1],
  [0.6, 0.6, 0.6],
  [0.7, 0.7, 0.7],
  [0.8, 0.6, 0.4],
  [1, 0.4, 0.4],
  [1, 0.1, 0.1],
];

/** Sentinel colour for the "sky"/miss ray (`distance==1, alignment==0, material==0`). */
const SKY: readonly [number, number, number] = [208, 230, 252];

const SHUFFLE_SEED = 1337;

/** Cache shuffled buffers by dimensions — deterministic, reused across a capture. */
const sampleBufferCache = new Map<string, Int16Array>();

/**
 * Build the shuffled (x, y) sample-position buffer for a frame of `width`×`height`.
 * Returns an `Int16Array` of `width*height*2` interleaved `x, y` pairs, where the
 * `sampleOffset` of each broadcast indexes (pre-doubled) into this buffer.
 */
export function buildSamplePositionBuffer(width: number, height: number): Int16Array {
  const key = `${width}x${height}`;
  const cached = sampleBufferCache.get(key);
  if (cached) return cached;

  const samplePositionBuffer = new Int16Array(width * height * 2);
  for (let w = 0, _ = 0; _ < height; _++) {
    for (let g = 0; g < width; g++) {
      samplePositionBuffer[w] = g;
      samplePositionBuffer[++w] = _;
      w++;
    }
  }

  for (let B = new IndexGenerator(SHUFFLE_SEED), R = width * height - 1; R >= 1; R--) {
    const C = 2 * R;
    const I = 2 * B.nextInt(R + 1);
    const P = samplePositionBuffer[C];
    const k = samplePositionBuffer[C + 1];
    const A = samplePositionBuffer[I];
    const F = samplePositionBuffer[I + 1];
    samplePositionBuffer[I] = P;
    samplePositionBuffer[I + 1] = k;
    samplePositionBuffer[C] = A;
    samplePositionBuffer[C + 1] = F;
  }

  sampleBufferCache.set(key, samplePositionBuffer);
  return samplePositionBuffer;
}

/**
 * Decode every ray frame into a sparse `output` array of {@link DecodedRay} indexed
 * by pixel position. Later frames overwrite earlier samples at the same pixel
 * (last-writer-wins). The 64-entry lookback table resets per frame, matching the
 * reference decoder.
 */
export function decodeRays(
  frames: readonly CameraRayFrame[],
  samplePositionBuffer: Int16Array,
  width: number,
  height: number,
): (DecodedRay | undefined)[] {
  const output: (DecodedRay | undefined)[] = new Array(width * height);

  for (const frame of frames) {
    let sampleOffset = 2 * frame.sampleOffset;
    let dataPointer = 0;
    const rayLookback: [number, number, number][] = new Array(64);
    for (let r = 0; r < 64; r++) rayLookback[r] = [0, 0, 0];

    const rayData = frame.rayData;

    while (true) {
      if (dataPointer >= rayData.length - 1) break;

      let t: number;
      let r: number;
      let i: number;
      const n = rayData[dataPointer++];

      if (255 === n) {
        const l = rayData[dataPointer++];
        const o = rayData[dataPointer++];
        const s = rayData[dataPointer++];
        const u =
          (3 * (((t = (l << 2) | (o >> 6)) / 128) | 0) +
            5 * (((r = 63 & o) / 16) | 0) +
            7 * (i = s)) &
          63;
        const f = rayLookback[u];
        f[0] = t;
        f[1] = r;
        f[2] = i;
      } else {
        const c = 192 & n;
        if (0 === c) {
          const h = 63 & n;
          const y = rayLookback[h];
          t = y[0];
          r = y[1];
          i = y[2];
        } else if (64 === c) {
          const p = 63 & n;
          const v = rayLookback[p];
          const b = v[0];
          const w = v[1];
          const _ = v[2];
          const g = rayData[dataPointer++];
          t = b + ((g >> 3) - 15);
          r = w + ((7 & g) - 3);
          i = _;
        } else if (128 === c) {
          const R = 63 & n;
          const C = rayLookback[R];
          const I = C[0];
          const P = C[1];
          const k = C[2];
          t = I + (rayData[dataPointer++] - 127);
          r = P;
          i = k;
        } else {
          const A = rayData[dataPointer++];
          const F = rayData[dataPointer++];
          const D =
            (3 * (((t = (A << 2) | (F >> 6)) / 128) | 0) +
              5 * (((r = 63 & F) / 16) | 0) +
              7 * (i = 63 & n)) &
            63;
          const E = rayLookback[D];
          E[0] = t;
          E[1] = r;
          E[2] = i;
        }
      }

      sampleOffset %= 2 * width * height;
      const index =
        samplePositionBuffer[sampleOffset++] + samplePositionBuffer[sampleOffset++] * width;
      output[index] = [t / 1023, r / 63, i];
    }
  }

  return output;
}

/**
 * Colourise a decoded ray buffer and encode it as a PNG. Pixels are written
 * Y-flipped (the camera's origin is bottom-left). Undecoded pixels stay black.
 * `pngjs` is imported lazily so it loads only when a frame is actually rendered.
 */
export async function encodeFrameToPng(
  output: (DecodedRay | undefined)[],
  width: number,
  height: number,
): Promise<Uint8Array> {
  // pngjs is CommonJS; access PNG robustly across Node's CJS→ESM interop shapes.
  const mod = (await import("pngjs")) as unknown as {
    PNG?: typeof import("pngjs").PNG;
    default?: { PNG: typeof import("pngjs").PNG };
  };
  const PNG = mod.PNG ?? mod.default?.PNG;
  if (!PNG) throw new Error("pngjs: PNG export not found");
  const png = new PNG({ width, height });

  for (let i = 0; i < output.length; i++) {
    const ray = output[i];
    if (!ray) continue;

    const distance = ray[0];
    const alignment = ray[1];
    const material = ray[2];

    let rgb: readonly [number, number, number];
    if (distance === 1 && alignment === 0 && material === 0) {
      rgb = SKY;
    } else {
      const colour = COLOURS[material] ?? COLOURS[0];
      rgb = [alignment * colour[0] * 255, alignment * colour[1] * 255, alignment * colour[2] * 255];
    }

    const x = i % width;
    const y = height - 1 - Math.floor(i / width);
    const dst = (y * width + x) << 2;
    png.data[dst] = rgb[0];
    png.data[dst + 1] = rgb[1];
    png.data[dst + 2] = rgb[2];
    png.data[dst + 3] = 255;
  }

  return PNG.sync.write(png);
}

/**
 * Render accumulated camera ray frames into a PNG buffer. Convenience that builds
 * the shuffled sample buffer, replays every frame, and encodes the result.
 */
export async function renderFrames(
  width: number,
  height: number,
  frames: readonly CameraRayFrame[],
): Promise<Uint8Array> {
  const samplePositionBuffer = buildSamplePositionBuffer(width, height);
  const output = decodeRays(frames, samplePositionBuffer, width, height);
  return encodeFrameToPng(output, width, height);
}
