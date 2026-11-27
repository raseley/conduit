/**
 * Protobuf wire primitives for the push client: a {@link Writer} and a
 * {@link Reader}, hand-rolled so fcm needs neither protobufjs nor `Long`.
 *
 * Only what Google's push messages use is supported: varint (wire type 0),
 * fixed64 (1) and length-delimited (2) are read and written; fixed32 (5) is only
 * ever skipped; groups (3, 4) are rejected. 64-bit values are `bigint` here and
 * decimal strings at the edges (see `messages.ts`).
 *
 * The Reader is a trust boundary: every byte it sees came off a socket. It
 * fails closed with {@link ProtocolError}: lengths are checked against the
 * remaining buffer before any slice, varints are capped at 10 bytes (5 for a
 * 32-bit varint), strings must be valid UTF-8, and there is no reflection and
 * no object keyed by a field name read from the wire.
 */

import { ProtocolError } from "../errors.js";

/** Protobuf wire types. */
export const WireType = {
  Varint: 0,
  Fixed64: 1,
  LengthDelimited: 2,
  StartGroup: 3,
  EndGroup: 4,
  Fixed32: 5,
} as const;

/** The longest a varint can be: 64 bits at 7 bits per byte. */
const MAX_VARINT_BYTES = 10;
/** The longest a 32-bit varint (a tag, a length, a frame size) can be. */
export const MAX_VARINT32_BYTES = 5;

const UINT64_LIMIT = 1n << 64n;
const INT64_MIN = -(1n << 63n);
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const UINT32_MAX = 2 ** 32 - 1;
/** Field numbers are 29 bits. */
const MAX_FIELD_NUMBER = 2 ** 29 - 1;

const utf8Encoder = new TextEncoder();
// `fatal` makes invalid UTF-8 throw instead of decoding to U+FFFD, so a corrupt
// string fails closed rather than reaching the payload decoder garbled.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Parse a decimal string as an unsigned 64-bit integer. Used for the
 * `androidId`/`securityToken` the push client stores as decimal strings.
 */
export function parseUint64Decimal(value: string, what: string): bigint {
  if (!/^[0-9]{1,20}$/.test(value)) {
    throw new ProtocolError(`${what} is not a decimal integer`);
  }
  const parsed = BigInt(value);
  if (parsed >= UINT64_LIMIT) {
    throw new ProtocolError(`${what} does not fit in 64 bits`);
  }
  return parsed;
}

/** Builds one protobuf message. Fields are written in the order the calls are made. */
export class Writer {
  private buf = new Uint8Array(64);
  private len = 0;

  /** A varint of a non-negative value below 2^64. */
  varint(value: bigint | number): this {
    let v = typeof value === "bigint" ? value : BigInt(value);
    if (v < 0n || v >= UINT64_LIMIT) {
      throw new ProtocolError("varint value out of range");
    }
    this.reserve(MAX_VARINT_BYTES);
    while (v >= 0x80n) {
      this.buf[this.len++] = Number(v & 0x7fn) | 0x80;
      v >>= 7n;
    }
    this.buf[this.len++] = Number(v);
    return this;
  }

  /** A field key: field number and wire type. */
  tag(field: number, wireType: number): this {
    if (!Number.isInteger(field) || field < 1 || field > MAX_FIELD_NUMBER) {
      throw new ProtocolError(`invalid field number ${field}`);
    }
    return this.varint(field * 8 + wireType);
  }

  /** A `uint32` field. */
  uint32(field: number, value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
      throw new ProtocolError(`uint32 field ${field} out of range`);
    }
    return this.tag(field, WireType.Varint).varint(value);
  }

  /**
   * An `int32` (or enum) field. A negative value is written as its 64-bit two's
   * complement, ten bytes, as protobufjs and protoc do.
   */
  int32(field: number, value: number): this {
    if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
      throw new ProtocolError(`int32 field ${field} out of range`);
    }
    return this.tag(field, WireType.Varint).varint(BigInt.asUintN(64, BigInt(value)));
  }

  /** A `bool` field. `false` is written too: presence is the caller's choice. */
  bool(field: number, value: boolean): this {
    return this.tag(field, WireType.Varint).varint(value ? 1 : 0);
  }

  /**
   * An `int64` field, written through its 64-bit two's-complement pattern. Takes
   * any value in [-2^63, 2^64): an unsigned value at or above 2^63 has the same
   * pattern as the negative number it wraps to.
   */
  int64(field: number, value: bigint): this {
    if (value < INT64_MIN || value >= UINT64_LIMIT) {
      throw new ProtocolError(`int64 field ${field} out of range`);
    }
    return this.tag(field, WireType.Varint).varint(BigInt.asUintN(64, value));
  }

  /** A `uint64` field. */
  uint64(field: number, value: bigint): this {
    return this.tag(field, WireType.Varint).varint(value);
  }

  /** A `fixed64` field: eight bytes, little-endian. */
  fixed64(field: number, value: bigint): this {
    if (value < 0n || value >= UINT64_LIMIT) {
      throw new ProtocolError(`fixed64 field ${field} out of range`);
    }
    this.tag(field, WireType.Fixed64);
    this.reserve(8);
    new DataView(this.buf.buffer, this.buf.byteOffset).setBigUint64(this.len, value, true);
    this.len += 8;
    return this;
  }

  /** A `bytes` field. */
  bytes(field: number, value: Uint8Array): this {
    this.tag(field, WireType.LengthDelimited).varint(value.byteLength);
    this.reserve(value.byteLength);
    this.buf.set(value, this.len);
    this.len += value.byteLength;
    return this;
  }

  /** A `string` field, UTF-8 encoded. */
  string(field: number, value: string): this {
    return this.bytes(field, utf8Encoder.encode(value));
  }

  /** An embedded message field, built by `build` on a fresh writer. */
  message(field: number, build: (writer: Writer) => void): this {
    const inner = new Writer();
    build(inner);
    return this.bytes(field, inner.finish());
  }

  /** The bytes written so far (a copy). */
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  private reserve(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < needed) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
}

/** A field key read from the wire. */
export interface FieldTag {
  field: number;
  wireType: number;
}

/** Reads one protobuf message, front to back. Every read is bounds-checked. */
export class Reader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  /** Whether every byte has been consumed. */
  get done(): boolean {
    return this.pos >= this.buf.byteLength;
  }

  /**
   * The next field key. Rejects field number 0, the group wire types (3, 4,
   * which nothing Google sends here uses) and the undefined wire types 6 and 7.
   */
  tag(): FieldTag {
    const key = this.varint32();
    const field = Math.floor(key / 8);
    const wireType = key % 8;
    if (field === 0) {
      throw new ProtocolError("field number 0 is invalid");
    }
    if (wireType === WireType.StartGroup || wireType === WireType.EndGroup) {
      throw new ProtocolError(`group wire type on field ${field} is not supported`);
    }
    if (wireType > WireType.Fixed32) {
      throw new ProtocolError(`invalid wire type ${wireType} on field ${field}`);
    }
    return { field, wireType };
  }

  /** A varint of up to 10 bytes, as an unsigned 64-bit value. */
  varint(): bigint {
    let result = 0n;
    for (let i = 0; i < MAX_VARINT_BYTES; i++) {
      const byte = this.byte();
      if (i === MAX_VARINT_BYTES - 1 && byte > 1) {
        // The tenth byte holds only bit 63; anything more (a continuation bit
        // included, which would make the varint longer than 10 bytes)
        // overflows 64 bits.
        throw new ProtocolError("varint overflows 64 bits");
      }
      result |= BigInt(byte & 0x7f) << BigInt(7 * i);
      if ((byte & 0x80) === 0) return result;
    }
    throw new ProtocolError("varint longer than 10 bytes");
  }

  /** A varint of up to 5 bytes that fits in 32 bits (tags and lengths). */
  varint32(): number {
    let result = 0;
    for (let i = 0; i < MAX_VARINT32_BYTES; i++) {
      const byte = this.byte();
      result += (byte & 0x7f) * 2 ** (7 * i);
      if ((byte & 0x80) === 0) {
        if (result > UINT32_MAX) throw new ProtocolError("varint32 overflows 32 bits");
        return result;
      }
    }
    throw new ProtocolError("varint32 longer than 5 bytes");
  }

  /** An `int32` (or enum) value. A ten-byte negative encoding is truncated to 32 bits. */
  int32(): number {
    return Number(BigInt.asIntN(32, this.varint()));
  }

  /** A `uint32` value. */
  uint32(): number {
    return Number(BigInt.asUintN(32, this.varint()));
  }

  /** A `bool` value. */
  bool(): boolean {
    return this.varint() !== 0n;
  }

  /** An `int64` value (signed). */
  int64(): bigint {
    return BigInt.asIntN(64, this.varint());
  }

  /** A `uint64` value. */
  uint64(): bigint {
    return this.varint();
  }

  /** A `fixed64` value: eight bytes, little-endian, unsigned. */
  fixed64(): bigint {
    this.need(8);
    const value = new DataView(this.buf.buffer, this.buf.byteOffset).getBigUint64(this.pos, true);
    this.pos += 8;
    return value;
  }

  /** A length-delimited value, copied out so the frame buffer is not retained. */
  bytes(): Uint8Array {
    const length = this.varint32();
    this.need(length);
    const out = this.buf.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  /** A length-delimited UTF-8 string. Invalid UTF-8 throws. */
  string(): string {
    const raw = this.bytes();
    try {
      return utf8Decoder.decode(raw);
    } catch (err) {
      throw new ProtocolError("string is not valid UTF-8", { cause: err });
    }
  }

  /** Skip one value of `wireType`: how unknown fields are passed over. */
  skip(wireType: number): void {
    switch (wireType) {
      case WireType.Varint:
        this.varint();
        return;
      case WireType.Fixed64:
        this.advance(8);
        return;
      case WireType.LengthDelimited:
        this.advance(this.varint32());
        return;
      case WireType.Fixed32:
        this.advance(4);
        return;
      default:
        throw new ProtocolError(`cannot skip wire type ${wireType}`);
    }
  }

  private byte(): number {
    this.need(1);
    return this.buf[this.pos++] as number;
  }

  private advance(count: number): void {
    this.need(count);
    this.pos += count;
  }

  private need(count: number): void {
    if (count > this.buf.byteLength - this.pos) {
      throw new ProtocolError("message is truncated");
    }
  }
}
