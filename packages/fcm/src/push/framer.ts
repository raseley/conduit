/**
 * The MCS frame parser: turns the byte stream from Google's push socket into
 * frames. A pure state machine with no socket knowledge, so it is tested by
 * feeding it bytes.
 *
 * Portions derived from @liamcottle/push-receiver's `parser.js` (MIT License,
 * Copyright (c) 2017 Matthieu Lemoine; https://github.com/liamcottle/push-receiver),
 * itself modelled on Chromium's `connection_handler_impl.cc` (BSD 3-Clause
 * License, Copyright 2013 The Chromium Authors;
 * https://chromium.googlesource.com/chromium/src/+/main/LICENSE).
 *
 * The stream starts with one version byte, then frames of: a 1-byte tag, the
 * payload size as a varint32 (at most 5 bytes), and the payload.
 */

import { ProtocolError } from "../errors.js";
import { MCS_VERSION } from "./messages.js";
import { copyBytes, MAX_VARINT32_BYTES } from "./wire.js";

/**
 * The largest frame payload accepted: 64 KiB. Real frames are a few KB (FCM caps
 * a push's data at 4 KB), so this is about 16 times headroom, and a corrupt or
 * hostile size can never make Conduit reserve large memory or wait for data
 * that never comes. A size over it throws, and the caller rebuilds the
 * connection.
 */
export const MAX_FRAME_BYTES = 64 * 1024;

/**
 * An older MCS version Google may still answer with; push-receiver (after
 * Chromium) accepts it alongside {@link MCS_VERSION} and above.
 */
const LEGACY_MCS_VERSION = 38;

/** The largest size a varint32 can carry. */
const UINT32_MAX = 2 ** 32 - 1;

/** The receive buffer's starting (and shrink-back) capacity. */
const INITIAL_BUFFER_BYTES = 4096;

/** One MCS frame. */
export interface Frame {
  tag: number;
  payload: Uint8Array;
}

/** A stream parser. `push` returns the frames each chunk completes. */
export interface Framer {
  /**
   * Feed the next chunk read from the socket; returns every frame it completes
   * (possibly none). The chunk is copied, so the caller may reuse its buffer,
   * and every payload is a fresh copy.
   *
   * A bad version byte, an overlong size varint or a size over the cap throws
   * {@link ProtocolError}. Frames completed earlier in the same chunk are still
   * returned; the error is then thrown by the next call instead. Once failed,
   * the framer stays failed: every later call throws that error.
   */
  push(chunk: Uint8Array): Frame[];
}

export function createFramer(options: { maxFrameBytes?: number } = {}): Framer {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes <= 0 || maxFrameBytes > UINT32_MAX) {
    throw new ProtocolError(`maxFrameBytes must be a positive integer, got ${maxFrameBytes}`);
  }
  // What a partial frame can occupy: version byte, tag, size varint, payload.
  const maxPartialBytes = 2 + MAX_VARINT32_BYTES + maxFrameBytes;

  let versionSeen = false;
  let failure: ProtocolError | undefined;
  // Received but unparsed bytes, buf[0..len). Chunks are appended into spare
  // capacity (doubling when full), so a frame that trickles in byte by byte
  // costs linear, not quadratic, copying. After each push only the tail of one
  // partial frame remains, so what is kept is bounded by the cap.
  let buf = new Uint8Array(INITIAL_BUFFER_BYTES);
  let len = 0;

  function append(chunk: Uint8Array): void {
    const needed = len + chunk.byteLength;
    if (needed > buf.byteLength) {
      let size = buf.byteLength * 2;
      while (size < needed) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(buf.subarray(0, len));
      buf = grown;
    }
    buf.set(chunk, len);
    len = needed;
  }

  /** Drop the first `count` bytes, and give back capacity a large chunk grew. */
  function consume(count: number): void {
    if (count > 0) {
      buf.copyWithin(0, count, len);
      len -= count;
    }
    if (buf.byteLength > INITIAL_BUFFER_BYTES && buf.byteLength > 2 * maxPartialBytes) {
      const shrunk = new Uint8Array(Math.max(INITIAL_BUFFER_BYTES, len));
      shrunk.set(buf.subarray(0, len));
      buf = shrunk;
    }
  }

  /** Parse complete frames into `frames`; returns how many bytes they used. */
  function parse(frames: Frame[]): number {
    let pos = 0;
    if (!versionSeen) {
      if (len < 1) return 0;
      // Read as a signed byte, as push-receiver does: a version byte of 128 or
      // more is negative there, and rejected.
      const version = ((buf[0] as number) << 24) >> 24;
      if (version < MCS_VERSION && version !== LEGACY_MCS_VERSION) {
        throw new ProtocolError(`unsupported MCS version ${version}`);
      }
      versionSeen = true;
      pos = 1;
    }

    for (;;) {
      // Tag byte plus at least one size byte.
      if (len - pos < 2) return pos;
      const tag = buf[pos] as number;
      let size = 0;
      let cursor = pos + 1;
      let sizeComplete = false;
      for (let i = 0; i < MAX_VARINT32_BYTES && cursor < len; i++) {
        const byte = buf[cursor++] as number;
        size += (byte & 0x7f) * 2 ** (7 * i);
        if ((byte & 0x80) === 0) {
          sizeComplete = true;
          break;
        }
        if (i === MAX_VARINT32_BYTES - 1) {
          throw new ProtocolError("MCS frame size varint is longer than 5 bytes");
        }
      }
      if (!sizeComplete) return pos;
      if (size > maxFrameBytes) {
        throw new ProtocolError(
          `MCS frame of ${size} bytes is over the ${maxFrameBytes}-byte cap (tag ${tag})`,
        );
      }
      if (len - cursor < size) return pos;
      // Unknown tags are returned too (the size says where the frame ends), so
      // a new message type from Google does not break push delivery until a
      // release; the caller decides what to do with them.
      frames.push({ tag, payload: copyBytes(buf, cursor, cursor + size) });
      pos = cursor + size;
    }
  }

  return {
    push(chunk) {
      if (failure) throw failure;
      append(chunk);
      const frames: Frame[] = [];
      try {
        consume(parse(frames));
      } catch (err) {
        failure =
          err instanceof ProtocolError
            ? err
            : new ProtocolError("MCS stream could not be parsed", { cause: err });
        len = 0;
        buf = new Uint8Array(0);
        // Hand out the good frames before the bad one; the next call throws.
        if (frames.length > 0) return frames;
        throw failure;
      }
      return frames;
    },
  };
}

/**
 * One outgoing MCS frame: the tag, the payload size as a varint, the payload.
 * Pass `version` for the first frame of a connection (the login), which is
 * preceded by the version byte.
 */
export function encodeFrame(
  tag: number,
  payload: Uint8Array,
  options: { version?: number } = {},
): Uint8Array {
  if (!Number.isInteger(tag) || tag < 0 || tag > 0xff) {
    throw new ProtocolError(`MCS tag ${tag} does not fit in a byte`);
  }
  const { version } = options;
  if (version !== undefined && (!Number.isInteger(version) || version < 0 || version > 0xff)) {
    throw new ProtocolError(`MCS version ${version} does not fit in a byte`);
  }
  if (payload.byteLength > UINT32_MAX) {
    throw new ProtocolError("MCS frame payload is too large for a varint32 size");
  }
  const header: number[] = [];
  if (version !== undefined) header.push(version);
  header.push(tag);
  let size = payload.byteLength;
  while (size >= 0x80) {
    header.push((size & 0x7f) | 0x80);
    size = Math.floor(size / 128);
  }
  header.push(size);
  const out = new Uint8Array(header.length + payload.byteLength);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}
