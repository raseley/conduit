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
import { MAX_VARINT32_BYTES } from "./wire.js";

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

/** One MCS frame. */
export interface Frame {
  tag: number;
  payload: Uint8Array;
}

/** A stream parser. `push` returns the frames each chunk completes. */
export interface Framer {
  /**
   * Feed the next chunk read from the socket; returns every frame it completes
   * (possibly none). Throws {@link ProtocolError} on a bad version byte, an
   * overlong size varint or a size over the cap; after a throw the framer stays
   * failed and every later call throws too.
   */
  push(chunk: Uint8Array): Frame[];
}

export function createFramer(options: { maxFrameBytes?: number } = {}): Framer {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  let versionSeen = false;
  let failure: ProtocolError | undefined;
  // The unparsed tail: at most one partial frame (6 header bytes plus the cap),
  // since every complete frame is handed out as soon as it arrives.
  let pending = new Uint8Array(0);

  function parse(chunk: Uint8Array): Frame[] {
    const buf = pending.byteLength === 0 ? chunk : concat(pending, chunk);
    let pos = 0;
    const frames: Frame[] = [];

    if (!versionSeen) {
      if (buf.byteLength < 1) return frames;
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
      if (buf.byteLength - pos < 2) break;
      const tag = buf[pos] as number;
      let size = 0;
      let cursor = pos + 1;
      let sizeComplete = false;
      for (let i = 0; i < MAX_VARINT32_BYTES && cursor < buf.byteLength; i++) {
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
      if (!sizeComplete) break;
      if (size > maxFrameBytes) {
        throw new ProtocolError(
          `MCS frame of ${size} bytes is over the ${maxFrameBytes}-byte cap (tag ${tag})`,
        );
      }
      if (buf.byteLength - cursor < size) break;
      // Unknown tags are returned too (the size says where the frame ends), so
      // a new message type from Google does not break push delivery until a
      // release; the caller decides what to do with them.
      frames.push({ tag, payload: buf.slice(cursor, cursor + size) });
      pos = cursor + size;
    }

    // Copy the tail so neither the caller's chunk nor a large joined buffer is
    // retained.
    pending = buf.slice(pos);
    return frames;
  }

  return {
    push(chunk) {
      if (failure) {
        throw new ProtocolError("MCS stream already failed", { cause: failure });
      }
      try {
        return parse(chunk);
      } catch (err) {
        failure =
          err instanceof ProtocolError
            ? err
            : new ProtocolError("MCS stream could not be parsed", { cause: err });
        throw failure;
      }
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
  const header: number[] = [];
  if (options.version !== undefined) header.push(options.version);
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

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
