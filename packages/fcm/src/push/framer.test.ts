import { describe, expect, it } from "vitest";

import { ProtocolError } from "../errors.js";
import { SERVER_FRAMES, SERVER_STREAM } from "./fixtures/mcs.js";
import { createFramer, encodeFrame, MAX_FRAME_BYTES, type Frame } from "./framer.js";
import { decodeDataMessageStanza, McsTag } from "./messages.js";

const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const stream = fromHex(SERVER_STREAM.hex);
const expected = SERVER_STREAM.frames.map((f) => ({ tag: f.tag, payloadHex: f.payloadHex }));

const asHex = (frames: Frame[]) =>
  frames.map((f) => ({ tag: f.tag, payloadHex: toHex(f.payload) }));

describe("createFramer", () => {
  it("parses the fixture stream in one chunk", () => {
    expect(asHex(createFramer().push(stream))).toEqual(expected);
  });

  it("gives the same frames however the stream is split in two", () => {
    for (let cut = 0; cut <= stream.byteLength; cut++) {
      const framer = createFramer();
      const frames = [...framer.push(stream.slice(0, cut)), ...framer.push(stream.slice(cut))];
      expect(asHex(frames), `split at ${cut}`).toEqual(expected);
    }
  });

  it("gives the same frames fed one byte at a time", () => {
    const framer = createFramer();
    const frames: Frame[] = [];
    for (let i = 0; i < stream.byteLength; i++) {
      frames.push(...framer.push(stream.slice(i, i + 1)));
    }
    expect(asHex(frames)).toEqual(expected);
  });

  it("passes an unknown tag through as a frame and carries on", () => {
    const frames = createFramer().push(stream);
    const unknown = frames.find((f) => f.tag === 15);
    expect(unknown && toHex(unknown.payload)).toBe("0a076d6164652d7570");
    // The frames after it still arrive.
    expect(frames.at(-1)?.tag).toBe(McsTag.Close);
  });

  it("hands out payloads that decode", () => {
    const data = createFramer()
      .push(stream)
      .find((f) => f.tag === McsTag.DataMessageStanza);
    expect(data && decodeDataMessageStanza(data.payload).persistentId).toBe(
      SERVER_FRAMES.dataMessage.input.persistentId,
    );
  });

  it("does not hand out views of the caller's chunk", () => {
    const chunk = stream.slice();
    const frames = createFramer().push(chunk);
    chunk.fill(0);
    expect(asHex(frames)).toEqual(expected);
  });

  it("does not hand out views of a Node Buffer chunk, whose slice() shares memory", () => {
    // Inside a larger pooled buffer, as socket reads often are.
    const pool = Buffer.alloc(stream.byteLength + 32, 0xee);
    pool.set(stream, 16);
    const chunk = pool.subarray(16, 16 + stream.byteLength);
    const frames = createFramer().push(chunk);
    pool.fill(0);
    expect(asHex(frames)).toEqual(expected);
    for (const frame of frames) expect(Buffer.isBuffer(frame.payload)).toBe(false);
  });

  it("survives the caller reusing its read buffer mid-frame", () => {
    const framer = createFramer();
    const readBuffer = Buffer.alloc(stream.byteLength);
    const frames: Frame[] = [];
    // Two reads into the same buffer, the first ending inside the data frame.
    const cut = Math.floor(stream.byteLength / 2);
    stream.subarray(0, cut).forEach((byte, i) => (readBuffer[i] = byte));
    frames.push(...framer.push(readBuffer.subarray(0, cut)));
    readBuffer.fill(0);
    stream.subarray(cut).forEach((byte, i) => (readBuffer[i] = byte));
    frames.push(...framer.push(readBuffer.subarray(0, stream.byteLength - cut)));
    expect(asHex(frames)).toEqual(expected);
  });

  it("takes a frame at the cap one byte at a time without quadratic copying", () => {
    const payload = new Uint8Array(MAX_FRAME_BYTES).fill(7);
    const bytes = encodeFrame(McsTag.DataMessageStanza, payload, { version: 41 });
    const framer = createFramer();
    const frames: Frame[] = [];
    for (let i = 0; i < bytes.byteLength; i++) {
      frames.push(...framer.push(bytes.subarray(i, i + 1)));
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toEqual(payload);
  });

  it("accepts version 38 and versions above 41", () => {
    const body = encodeFrame(McsTag.Close, new Uint8Array());
    for (const version of [38, 41, 42, 127]) {
      expect(createFramer().push(new Uint8Array([version, ...body]))).toEqual([
        { tag: McsTag.Close, payload: new Uint8Array() },
      ]);
    }
  });

  it.each([0, 37, 39, 40, 128, 255])("rejects version byte %i", (version) => {
    expect(() => createFramer().push(new Uint8Array([version]))).toThrow(ProtocolError);
  });

  it("rejects a size over the cap before waiting for the payload", () => {
    const header = encodeFrame(McsTag.DataMessageStanza, new Uint8Array(MAX_FRAME_BYTES + 1));
    // Only the version, tag and size bytes: the payload never needs to arrive.
    const sizeBytes = header.slice(0, 4);
    expect(() => createFramer().push(new Uint8Array([41, ...sizeBytes]))).toThrow(/cap/);
  });

  it("accepts a frame exactly at the cap", () => {
    const payload = new Uint8Array(MAX_FRAME_BYTES).fill(7);
    const frames = createFramer().push(
      encodeFrame(McsTag.DataMessageStanza, payload, { version: 41 }),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload.byteLength).toBe(MAX_FRAME_BYTES);
  });

  it("honours a custom cap", () => {
    const framer = createFramer({ maxFrameBytes: 4 });
    expect(() => framer.push(encodeFrame(8, new Uint8Array(5), { version: 41 }))).toThrow(
      ProtocolError,
    );
  });

  it("rejects a size varint longer than 5 bytes", () => {
    expect(() => createFramer().push(fromHex("2908808080808001"))).toThrow(/longer than 5 bytes/);
  });

  it("stays failed after a protocol error", () => {
    const framer = createFramer();
    expect(() => framer.push(new Uint8Array([1]))).toThrow(/unsupported MCS version 1/);
    expect(() => framer.push(stream)).toThrow(/unsupported MCS version 1/);
  });

  it("returns the good frames before a bad one, then throws on the next push", () => {
    const framer = createFramer();
    const good = [
      encodeFrame(McsTag.HeartbeatPing, fromHex("1003")),
      encodeFrame(McsTag.Close, new Uint8Array()),
    ];
    const oversize = encodeFrame(McsTag.DataMessageStanza, new Uint8Array(MAX_FRAME_BYTES + 1));
    const chunk = new Uint8Array([41, ...good[0]!, ...good[1]!, ...oversize.subarray(0, 4)]);
    expect(asHex(framer.push(chunk))).toEqual([
      { tag: McsTag.HeartbeatPing, payloadHex: "1003" },
      { tag: McsTag.Close, payloadHex: "" },
    ]);
    expect(() => framer.push(new Uint8Array())).toThrow(/cap/);
    expect(() => framer.push(stream)).toThrow(/cap/);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32])(
    "rejects maxFrameBytes %s",
    (maxFrameBytes) => {
      expect(() => createFramer({ maxFrameBytes })).toThrow(ProtocolError);
    },
  );

  it("an empty chunk yields nothing", () => {
    const framer = createFramer();
    expect(framer.push(new Uint8Array())).toEqual([]);
    expect(asHex(framer.push(stream))).toEqual(expected);
  });
});

describe("encodeFrame", () => {
  it("writes the tag, a varint size and the payload", () => {
    expect(toHex(encodeFrame(McsTag.Close, new Uint8Array()))).toBe("0400");
    const big = new Uint8Array(300);
    expect(toHex(encodeFrame(8, big).slice(0, 3))).toBe("08ac02");
  });

  it("puts the version byte first when asked", () => {
    expect(toHex(encodeFrame(McsTag.HeartbeatPing, fromHex("1003"), { version: 41 }))).toBe(
      "2900021003",
    );
  });

  it("rejects a tag that does not fit in a byte", () => {
    expect(() => encodeFrame(256, new Uint8Array())).toThrow(ProtocolError);
  });

  it.each([-1, 256, 1.5, Number.NaN])("rejects version %s", (version) => {
    expect(() => encodeFrame(McsTag.Close, new Uint8Array(), { version })).toThrow(ProtocolError);
  });
});
