import { describe, expect, it } from "vitest";

import { ProtocolError } from "../errors.js";
import { parseUint64Decimal, Reader, WireType, Writer } from "./wire.js";

const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** Read the one field in `bytes`, checking its key. */
function readOne<T>(bytes: Uint8Array, field: number, read: (r: Reader) => T): T {
  const r = new Reader(bytes);
  const tag = r.tag();
  expect(tag.field).toBe(field);
  const value = read(r);
  expect(r.done).toBe(true);
  return value;
}

describe("Writer and Reader round trips", () => {
  it.each([0n, 1n, 127n, 128n, 300n, 2n ** 32n, 2n ** 63n, 2n ** 64n - 1n])(
    "uint64 %s",
    (value) => {
      const bytes = new Writer().uint64(1, value).finish();
      expect(readOne(bytes, 1, (r) => r.uint64())).toBe(value);
    },
  );

  it.each([0n, 1n, -1n, -(2n ** 63n), 2n ** 63n - 1n])("int64 %s", (value) => {
    const bytes = new Writer().int64(1, value).finish();
    expect(readOne(bytes, 1, (r) => r.int64())).toBe(value);
  });

  it("int64 takes an unsigned value at or above 2^63 as its two's-complement pattern", () => {
    const unsigned = new Writer().int64(2, 2n ** 63n).finish();
    const signed = new Writer().int64(2, -(2n ** 63n)).finish();
    expect(toHex(unsigned)).toBe(toHex(signed));
    expect(readOne(unsigned, 2, (r) => r.int64())).toBe(-(2n ** 63n));
  });

  it.each([0, 1, -1, 2 ** 31 - 1, -(2 ** 31)])("int32 %s", (value) => {
    const bytes = new Writer().int32(1, value).finish();
    expect(readOne(bytes, 1, (r) => r.int32())).toBe(value);
  });

  it("writes a negative int32 as ten bytes, as protobufjs does", () => {
    expect(toHex(new Writer().int32(1, -1).finish())).toBe("08ffffffffffffffffff01");
  });

  it.each([0, 1, 2 ** 32 - 1])("uint32 %s", (value) => {
    const bytes = new Writer().uint32(3, value).finish();
    expect(readOne(bytes, 3, (r) => r.uint32())).toBe(value);
  });

  it("bool, including an explicit false", () => {
    expect(toHex(new Writer().bool(12, false).finish())).toBe("6000");
    expect(readOne(new Writer().bool(14, true).finish(), 14, (r) => r.bool())).toBe(true);
  });

  it.each([0n, 1n, 2n ** 63n, 2n ** 64n - 1n])("fixed64 %s, little-endian", (value) => {
    const bytes = new Writer().fixed64(7, value).finish();
    expect(bytes[0]).toBe((7 << 3) | WireType.Fixed64);
    expect(bytes.byteLength).toBe(9);
    expect(readOne(bytes, 7, (r) => r.fixed64())).toBe(value);
  });

  it("strings, including multi-byte UTF-8", () => {
    const text = "Raid alarm 💥 base ünder attack";
    const bytes = new Writer().string(2, text).finish();
    expect(readOne(bytes, 2, (r) => r.string())).toBe(text);
  });

  it("bytes, copied out", () => {
    const payload = fromHex("00ff10");
    const bytes = new Writer().bytes(21, payload).finish();
    const out = readOne(bytes, 21, (r) => r.bytes());
    expect(toHex(out)).toBe("00ff10");
    expect(out.buffer).not.toBe(bytes.buffer);
  });

  it("nested messages, and large ones that grow the buffer", () => {
    const long = "x".repeat(5000);
    const bytes = new Writer().message(4, (inner) => inner.string(2, long).int32(3, 1)).finish();
    const inner = new Reader(readOne(bytes, 4, (r) => r.bytes()));
    expect(inner.tag().field).toBe(2);
    expect(inner.string()).toBe(long);
    expect(inner.tag().field).toBe(3);
    expect(inner.int32()).toBe(1);
    expect(inner.done).toBe(true);
  });

  it("skips unknown fields of every supported wire type, fixed32 included", () => {
    // Field 1 varint, 2 fixed64, 3 length-delimited, 4 fixed32, then 5 varint = 1.
    const r = new Reader(
      fromHex("089601" + "110102030405060708" + "1a03616263" + "2501020304" + "2801"),
    );
    const seen: number[] = [];
    let last: boolean | undefined;
    while (!r.done) {
      const { field, wireType } = r.tag();
      seen.push(field);
      if (field === 5) last = r.bool();
      else r.skip(wireType);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(last).toBe(true);
  });
});

describe("Reader fails closed", () => {
  const expectProtocolError = (fn: () => unknown, message: RegExp): void => {
    expect(fn).toThrow(ProtocolError);
    expect(fn).toThrow(message);
  };

  it("rejects a truncated varint", () => {
    expectProtocolError(() => new Reader(fromHex("80")).varint(), /truncated/);
  });

  it("rejects a varint longer than 10 bytes", () => {
    // The tenth byte still has its continuation bit set.
    expectProtocolError(
      () => new Reader(fromHex("8080808080808080808001")).varint(),
      /overflows 64 bits/,
    );
  });

  it("rejects a tenth varint byte that overflows 64 bits", () => {
    expectProtocolError(
      () => new Reader(fromHex("ffffffffffffffffff02")).varint(),
      /overflows 64 bits/,
    );
  });

  it("rejects a tag or length varint longer than 5 bytes", () => {
    expectProtocolError(() => new Reader(fromHex("808080808001")).tag(), /longer than 5 bytes/);
    expectProtocolError(() => new Reader(fromHex("ffffffff1f")).varint32(), /overflows 32 bits/);
  });

  it("rejects a length that runs past the buffer", () => {
    expectProtocolError(() => new Reader(fromHex("05616263")).bytes(), /truncated/);
    expectProtocolError(
      () => new Reader(fromHex("1205616263")).skip(WireType.LengthDelimited),
      /truncated/,
    );
  });

  it("rejects a truncated fixed64 or fixed32", () => {
    expectProtocolError(() => new Reader(fromHex("01020304")).fixed64(), /truncated/);
    expectProtocolError(() => new Reader(fromHex("0102")).skip(WireType.Fixed32), /truncated/);
  });

  it("rejects invalid UTF-8", () => {
    expectProtocolError(() => new Reader(fromHex("02c328")).string(), /UTF-8/);
    expectProtocolError(() => new Reader(fromHex("01ff")).string(), /UTF-8/);
  });

  it("rejects the group wire types", () => {
    expectProtocolError(() => new Reader(fromHex("0b")).tag(), /group/);
    expectProtocolError(() => new Reader(fromHex("0c")).tag(), /group/);
    expectProtocolError(() => new Reader(new Uint8Array()).skip(WireType.StartGroup), /skip/);
  });

  it("rejects the undefined wire types and field number 0", () => {
    expectProtocolError(() => new Reader(fromHex("0e")).tag(), /wire type 6/);
    expectProtocolError(() => new Reader(fromHex("0f")).tag(), /wire type 7/);
    expectProtocolError(() => new Reader(fromHex("00")).tag(), /field number 0/);
  });
});

describe("Writer rejects values it cannot encode", () => {
  it.each([
    ["int32 above range", () => new Writer().int32(1, 2 ** 31)],
    ["int32 fraction", () => new Writer().int32(1, 1.5)],
    ["uint32 negative", () => new Writer().uint32(1, -1)],
    ["int64 below range", () => new Writer().int64(1, -(2n ** 63n) - 1n)],
    ["int64 at 2^64", () => new Writer().int64(1, 2n ** 64n)],
    ["fixed64 negative", () => new Writer().fixed64(1, -1n)],
    ["uint64 at 2^64", () => new Writer().uint64(1, 2n ** 64n)],
    ["field 0", () => new Writer().int32(0, 1)],
  ])("%s", (_name, fn) => {
    expect(fn).toThrow(ProtocolError);
  });
});

describe("parseUint64Decimal", () => {
  it("accepts every 64-bit unsigned decimal", () => {
    expect(parseUint64Decimal("0", "id")).toBe(0n);
    expect(parseUint64Decimal("18446744073709551615", "id")).toBe(2n ** 64n - 1n);
  });

  it.each(["", "-1", "1.5", "0x10", " 1", "18446744073709551616", "123456789012345678901"])(
    "rejects %j",
    (value) => {
      expect(() => parseUint64Decimal(value, "androidId")).toThrow(ProtocolError);
    },
  );
});
