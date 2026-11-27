#!/usr/bin/env node
/**
 * capture-mcs-fixtures.mjs — one-off generator for the byte fixtures that prove
 * fcm's hand-rolled push codec (`src/push/`) matches `@liamcottle/push-receiver`
 * byte for byte.
 *
 * It runs push-receiver's OWN code and protobufjs definitions (the Chromium
 * `mcs.proto` / `checkin.proto` bundled in the package), so the fixtures are
 * exactly what the library sends today:
 *
 *  - check-in requests: push-receiver's `gcm.checkIn()` is run against a local
 *    HTTP server (its `https.request` is redirected there), and the server
 *    records the method, path, raw header list and body it receives, then
 *    answers with an encoded `AndroidCheckinResponse`. What `checkIn()` decodes
 *    from that answer is recorded too.
 *  - login requests: push-receiver's `Client#_loginBuffer()` (version byte, tag,
 *    length-delimited `LoginRequest`), for persistent-id lists of none, one and
 *    many, and androidIds at and above 2^63 (where its signed hex conversion
 *    gives `android--…`).
 *  - heartbeats and sample server frames, encoded with the bundled `mcs.proto`,
 *    plus a framed server stream that mixes them with an unknown tag.
 *
 * Every id, token and payload is MADE UP; none belongs to a real device or
 * account. Nothing here touches the network beyond 127.0.0.1.
 *
 * fcm does not depend on protobufjs or long (its lint rule forbids importing
 * them), so both are loaded through push-receiver's own location in
 * node_modules, the same copies the library itself uses.
 *
 * Usage (from the repo root), then format the output:
 *   node packages/fcm/scripts/capture-mcs-fixtures.mjs
 *   pnpm prettier --write packages/fcm/src/push/fixtures
 *
 * Removed together with push-receiver; the fixtures it wrote stay as codec test
 * data.
 */

import http from "node:http";
import https from "node:https";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fcmDir = resolve(here, "..");
const outDir = resolve(fcmDir, "src/push/fixtures");

// Resolve push-receiver from fcm (which depends on it), then load protobufjs and
// long from push-receiver's own location.
const requireFromFcm = createRequire(resolve(fcmDir, "package.json"));
const pushReceiverPackage = requireFromFcm.resolve("@liamcottle/push-receiver/package.json");
const pushReceiverDir = dirname(pushReceiverPackage);
const requireFromPushReceiver = createRequire(pushReceiverPackage);
const pushReceiverVersion = requireFromPushReceiver("./package.json").version;
const protobuf = requireFromPushReceiver("protobufjs");
const Long = requireFromPushReceiver("long");
// Loading gcm first installs push-receiver's `protobuf.util.Long` override.
const gcm = requireFromPushReceiver("./src/gcm/index.js");
const Client = requireFromPushReceiver("./src/client.js");

const mcsRoot = await protobuf.load(resolve(pushReceiverDir, "src/mcs.proto"));
const checkinRoot = await protobuf.load(resolve(pushReceiverDir, "src/gcm/checkin.proto"));

const hex = (bytes) => Buffer.from(bytes).toString("hex");

function encode(root, typeName, object) {
  const type = root.lookupType(typeName);
  const message = type.fromObject(object);
  const problem = type.verify(message);
  if (problem) throw new Error(`${typeName}: ${problem}`);
  return Buffer.from(type.encode(message).finish());
}

/** One MCS frame as the server writes it: tag byte, varint32 size, payload. */
function frame(tag, payload) {
  const size = Buffer.from(protobuf.Writer.create().uint32(payload.length).finish());
  return Buffer.concat([Buffer.from([tag]), size, payload]);
}

// ---------------------------------------------------------------------------
// Check-in: run push-receiver's checkIn against a local server.
// ---------------------------------------------------------------------------

/**
 * Run `gcm.checkIn(androidId, securityToken)` with `https.request` redirected to
 * a local plain-HTTP server. `request` (push-receiver's HTTP client) writes its
 * own `host` header, so the header list is what Google would see; only the
 * transport differs.
 */
async function captureCheckIn(androidId, securityToken, responseBytes) {
  let captured;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const pairs = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        pairs.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
      }
      captured = {
        method: req.method,
        path: req.url,
        headers: pairs,
        body: Buffer.concat(chunks),
      };
      res.writeHead(200, { "Content-Type": "application/x-protobuf" });
      res.end(responseBytes);
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();

  const realRequest = https.request;
  https.request = (options, callback) => {
    // `request` hands over an https Agent; a plain-HTTP socket needs http's own
    // global agent, which has the same keep-alive default.
    const { agent: _httpsAgent, ...rest } = options;
    return http.request(
      { ...rest, protocol: "http:", host: "127.0.0.1", hostname: "127.0.0.1", port },
      callback,
    );
  };
  let decoded;
  try {
    decoded = await gcm.checkIn(androidId, securityToken);
  } finally {
    https.request = realRequest;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  return { ...captured, decoded };
}

const checkinResponses = {
  ordinary: {
    input: {
      statsOk: true,
      timeMsec: "1764000000000",
      androidId: "4123456789012345678",
      securityToken: "1234567890123456789",
      versionInfo: "made-up-version-info",
      settingsDiff: false,
      digest: "made-up-digest",
      setting: [{ name: Buffer.from("made-up-name"), value: Buffer.from("made-up-value") }],
      marketOk: true,
    },
  },
  // Both ids at or above 2^63: fixed64 on the wire, unsigned decimal out.
  high: {
    input: {
      statsOk: true,
      androidId: "9223372036854775808",
      securityToken: "18446744073709551615",
    },
  },
};
for (const entry of Object.values(checkinResponses)) {
  entry.hex = hex(encode(checkinRoot, "checkin_proto.AndroidCheckinResponse", entry.input));
}

const checkinCases = [
  // First-run registration checks in without ids.
  { name: "fresh", androidId: undefined, securityToken: undefined, reply: "ordinary" },
  // Every listen re-checks in with the stored ids.
  {
    name: "existing",
    androidId: "4123456789012345678",
    securityToken: "1234567890123456789",
    reply: "ordinary",
  },
  // androidId at 2^63: push-receiver's signed Long wraps it to int64 min.
  {
    name: "highIds",
    androidId: "9223372036854775808",
    securityToken: "18446744073709551615",
    reply: "high",
  },
];
const checkinRequests = {};
for (const c of checkinCases) {
  const reply = checkinResponses[c.reply];
  const result = await captureCheckIn(c.androidId, c.securityToken, Buffer.from(reply.hex, "hex"));
  checkinRequests[c.name] = {
    androidId: c.androidId ?? null,
    securityToken: c.securityToken ?? null,
    method: result.method,
    path: result.path,
    headers: result.headers,
    bodyHex: hex(result.body),
    reply: c.reply,
    decoded: { androidId: result.decoded.androidId, securityToken: result.decoded.securityToken },
  };
}

// ---------------------------------------------------------------------------
// Login: push-receiver's own login buffer.
// ---------------------------------------------------------------------------

await Client.init();
const loginCases = {
  noPersistentIds: {
    androidId: "4123456789012345678",
    securityToken: "1234567890123456789",
    persistentIds: [],
  },
  onePersistentId: {
    androidId: "4123456789012345678",
    securityToken: "1234567890123456789",
    persistentIds: ["0:1764000000000001%0000000000000000"],
  },
  manyPersistentIds: {
    androidId: "4123456789012345678",
    securityToken: "1234567890123456789",
    persistentIds: [
      "0:1764000000000001%0000000000000000",
      "0:1764000000000002%0000000000000000",
      "0:1764000000000003%0000000000000000",
    ],
  },
  // 2^63: the signed conversion gives android--8000000000000000.
  androidIdAt2pow63: {
    androidId: "9223372036854775808",
    securityToken: "18446744073709551615",
    persistentIds: [],
  },
  // 2^64 - 1: the signed conversion gives android--1.
  androidIdMax: {
    androidId: "18446744073709551615",
    securityToken: "1",
    persistentIds: ["0:1764000000000004%0000000000000000"],
  },
};
const loginRequests = {};
for (const [name, c] of Object.entries(loginCases)) {
  const client = new Client(c.androidId, c.securityToken, [...c.persistentIds]);
  loginRequests[name] = {
    ...c,
    deviceId: `android-${Long.fromString(c.androidId).toString(16)}`,
    frameHex: hex(client._loginBuffer()),
  };
}

// ---------------------------------------------------------------------------
// Heartbeats (client side) and sample server frames.
// ---------------------------------------------------------------------------

const heartbeats = {
  pingEmpty: { type: "HeartbeatPing", input: {} },
  ping: { type: "HeartbeatPing", input: { lastStreamIdReceived: 3 } },
  ack: { type: "HeartbeatAck", input: { lastStreamIdReceived: 3 } },
};
for (const entry of Object.values(heartbeats)) {
  entry.hex = hex(encode(mcsRoot, `mcs_proto.${entry.type}`, entry.input));
}

const longBody = JSON.stringify({
  img: "",
  port: "28017",
  name: "Made-up server",
  id: "00000000-0000-0000-0000-000000000000",
  type: "server",
  url: "",
  desc: "A made-up description long enough to need a two-byte frame size.",
  playerId: "70000000000000000",
  playerToken: "-1",
});

const serverFrames = {
  loginResponseOk: {
    tag: 3,
    type: "LoginResponse",
    input: {
      id: "made-up-login-id",
      setting: [{ name: "made-up-setting", value: "1" }],
      streamId: 1,
      lastStreamIdReceived: 1,
      heartbeatConfig: { uploadStat: false, ip: "", intervalMs: 300000 },
      serverTimestamp: "1764000000000",
    },
  },
  loginResponseError: {
    tag: 3,
    type: "LoginResponse",
    input: {
      id: "made-up-login-id",
      error: { code: 401, message: "made-up message", type: "made-up-type" },
    },
  },
  // A negative int32 is a 10-byte varint on the wire.
  loginResponseNegativeCode: {
    tag: 3,
    type: "LoginResponse",
    input: { id: "made-up-login-id", error: { code: -1 } },
  },
  dataMessage: {
    tag: 8,
    type: "DataMessageStanza",
    input: {
      id: "made-up-message-id",
      from: "000000000000",
      category: "com.facepunch.rust.companion",
      token: "made-up-collapse-key",
      appData: [
        { key: "experienceId", value: "@made-up/experience" },
        { key: "title", value: "Made-up title" },
        { key: "message", value: "Made-up message" },
        { key: "body", value: longBody },
      ],
      persistentId: "0:1764000000000005%0000000000000000",
      streamId: 5,
      lastStreamIdReceived: 4,
      ttl: 2419200,
      sent: "1764000000",
      queued: 2,
      immediateAck: true,
    },
  },
  dataMessageEncrypted: {
    tag: 8,
    type: "DataMessageStanza",
    input: {
      from: "000000000000",
      category: "org.chromium.linux",
      appData: [
        { key: "crypto-key", value: "dh=made-up" },
        { key: "encryption", value: "salt=made-up" },
      ],
      persistentId: "0:1764000000000006%0000000000000000",
      rawData: Buffer.from("made-up-ciphertext"),
      sent: "1764000001",
    },
  },
  dataMessageMinimal: {
    tag: 8,
    type: "DataMessageStanza",
    input: { from: "000000000000", category: "com.facepunch.rust.companion" },
  },
  heartbeatPing: {
    tag: 0,
    type: "HeartbeatPing",
    input: { streamId: 2, lastStreamIdReceived: 6, status: "1" },
  },
  heartbeatAck: {
    tag: 1,
    type: "HeartbeatAck",
    input: { streamId: 3, lastStreamIdReceived: 7 },
  },
  close: { tag: 4, type: "Close", input: {} },
  streamError: {
    tag: 10,
    type: "StreamErrorStanza",
    input: { type: "made-up-error-type", text: "made-up text" },
  },
  iqStanza: {
    tag: 7,
    type: "IqStanza",
    input: {
      rmqId: "1",
      type: 1,
      id: "made-up-iq-id",
      extension: { id: 12, data: Buffer.from("made-up") },
      streamId: 8,
      lastStreamIdReceived: 7,
    },
  },
};
for (const entry of Object.values(serverFrames)) {
  entry.hex = hex(encode(mcsRoot, `mcs_proto.${entry.type}`, entry.input));
}

// A server stream: version byte, then frames, including a tag no known message
// uses and a zero-size Close.
const UNKNOWN_TAG = 15;
const unknownPayload = Buffer.from("0a076d6164652d7570", "hex");
const streamFrames = [
  { tag: 3, payloadHex: serverFrames.loginResponseOk.hex },
  { tag: 7, payloadHex: serverFrames.iqStanza.hex },
  { tag: 0, payloadHex: serverFrames.heartbeatPing.hex },
  { tag: 8, payloadHex: serverFrames.dataMessage.hex },
  { tag: UNKNOWN_TAG, payloadHex: hex(unknownPayload) },
  { tag: 8, payloadHex: serverFrames.dataMessageMinimal.hex },
  { tag: 4, payloadHex: serverFrames.close.hex },
];
const serverStream = {
  version: 41,
  frames: streamFrames,
  hex: hex(
    Buffer.concat([
      Buffer.from([41]),
      ...streamFrames.map((f) => frame(f.tag, Buffer.from(f.payloadHex, "hex"))),
    ]),
  ),
};

// ---------------------------------------------------------------------------
// Write the fixture modules.
// ---------------------------------------------------------------------------

/** JSON.stringify that writes Buffers as hex strings. */
function literal(value) {
  return JSON.stringify(
    value,
    (_key, v) => (v && v.type === "Buffer" && Array.isArray(v.data) ? hex(v.data) : v),
    2,
  );
}

function header(what) {
  return `/**
 * ${what}
 *
 * GENERATED by \`packages/fcm/scripts/capture-mcs-fixtures.mjs\`; do not edit by hand.
 *
 * Made by running @liamcottle/push-receiver ${pushReceiverVersion}'s own code and its bundled
 * protobufjs definitions (Chromium's mcs.proto, checkin.proto and android_checkin.proto):
 * check-in requests come from its \`gcm.checkIn()\` run against a local HTTP server, login
 * requests from its \`Client#_loginBuffer()\`, and the remaining messages from protobufjs
 * encoding the inputs listed next to each fixture. Hex strings are the exact bytes. Bytes
 * written as \`Buffer\`s in an input appear here as hex.
 *
 * Every id, token and payload is MADE UP; none belongs to a real device or account.
 *
 * Regenerate (repo root): node packages/fcm/scripts/capture-mcs-fixtures.mjs, then
 * pnpm prettier --write packages/fcm/src/push/fixtures
 */
`;
}

writeFileSync(
  resolve(outDir, "checkin.ts"),
  `${header("Check-in fixtures: requests as push-receiver sends them, and server replies.")}
export const CHECKIN_RESPONSES = ${literal(checkinResponses)} as const;

export const CHECKIN_REQUESTS = ${literal(checkinRequests)} as const;
`,
);

writeFileSync(
  resolve(outDir, "mcs.ts"),
  `${header("MCS fixtures: login requests, heartbeats and sample server frames.")}
export const LOGIN_REQUESTS = ${literal(loginRequests)} as const;

export const HEARTBEATS = ${literal(heartbeats)} as const;

export const SERVER_FRAMES = ${literal(serverFrames)} as const;

export const SERVER_STREAM = ${literal(serverStream)} as const;
`,
);

console.log(`Wrote fixtures from push-receiver ${pushReceiverVersion} to ${outDir}`);
