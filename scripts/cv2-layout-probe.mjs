#!/usr/bin/env node
/**
 * cv2-layout-probe.mjs — post Components V2 layout variants to a SCRATCH Discord
 * channel, to settle the undocumented behaviour the Conduit Panel redesign (one
 * message per device type, edited in place) relies on. Not shipped, not part of
 * the build, no dependencies: it talks to Discord's REST API with Node's built-in
 * `fetch`.
 *
 * Usage (PowerShell; use a throwaway bot in a throwaway server, never Conduit's):
 *
 *   $env:PROBE_BOT_TOKEN = "<scratch bot token>"
 *   $env:PROBE_CHANNEL_ID = "<scratch text channel id>"
 *   node scripts/cv2-layout-probe.mjs            # post every variant (width, banner,
 *                                                # grouping, labels, emoji, budgets)
 *   node scripts/cv2-layout-probe.mjs grouping   # just one variant (see VARIANTS)
 *   node scripts/cv2-layout-probe.mjs edit-cap <messageId> [maxEdits]
 *        # edit one message older than 1 hour until Discord answers 30046
 *
 * Then look at the channel on desktop AND mobile and record the answers. The
 * script prints a Markdown results block (what Discord accepted or refused) to
 * keep alongside the screenshots.
 *
 * The bot needs View Channel, Send Messages and Attach Files in the channel. Every
 * button's custom id starts `probe:`, so clicking one only shows "interaction
 * failed" (nothing is listening), and Conduit's orphan sweep never matches it.
 */

import { deflateSync } from "node:zlib";

const API = "https://discord.com/api/v10";
const IS_COMPONENTS_V2 = 1 << 15;
const SUPPRESS_NOTIFICATIONS = 1 << 12;

// Component types (https://docs.discord.com/developers/components/reference).
const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
const SECTION = 9;
const TEXT_DISPLAY = 10;
const MEDIA_GALLERY = 12;
const SEPARATOR = 14;
const CONTAINER = 17;
const SECONDARY = 2;
const BLURPLE = 0x5865f2;

const token = process.env.PROBE_BOT_TOKEN;
const channelId = process.env.PROBE_CHANNEL_ID;
if (!token || !channelId) {
  console.error("Set PROBE_BOT_TOKEN and PROBE_CHANNEL_ID (a scratch bot and channel).");
  process.exit(2);
}

/** @type {{variant: string, check: string, outcome: string}[]} */
const results = [];
const record = (variant, check, outcome) => {
  results.push({ variant, check, outcome });
  console.log(`[${variant}] ${check}: ${outcome}`);
};

// ---------------------------------------------------------------------------
// REST helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One REST call, retrying a 429 after Discord's `retry_after`. Resolves to
 * `{ ok, status, body }`, never throws on an HTTP error (a refusal is a result).
 */
async function rest(method, path, { json, files } = {}) {
  for (;;) {
    let body;
    const headers = { Authorization: `Bot ${token}` };
    if (files) {
      const form = new FormData();
      form.append("payload_json", JSON.stringify(json));
      files.forEach((file, i) =>
        form.append(`files[${i}]`, new Blob([file.data], { type: file.type }), file.name),
      );
      body = form;
    } else if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    }
    const res = await fetch(`${API}${path}`, { method, headers, body });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (res.status === 429) {
      const wait = Math.ceil((parsed?.retry_after ?? 1) * 1000) + 100;
      console.log(`  rate limited, waiting ${wait} ms`);
      await sleep(wait);
      continue;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  }
}

const post = (components, { files, silent = true } = {}) =>
  rest("POST", `/channels/${channelId}/messages`, {
    json: {
      flags: IS_COMPONENTS_V2 | (silent ? SUPPRESS_NOTIFICATIONS : 0),
      components,
      allowed_mentions: { parse: [] },
    },
    files,
  });

const edit = (messageId, components) =>
  rest("PATCH", `/channels/${channelId}/messages/${messageId}`, {
    json: { flags: IS_COMPONENTS_V2, components, allowed_mentions: { parse: [] } },
  });

const describe = (res) =>
  res.ok
    ? `accepted (message ${res.body.id})`
    : `refused ${res.status} code ${res.body?.code ?? "?"}: ${JSON.stringify(res.body?.errors ?? res.body?.message).slice(0, 300)}`;

// ---------------------------------------------------------------------------
// Component builders (plain JSON, mirroring the Conduit Panel mock-up)

const text = (content) => ({ type: TEXT_DISPLAY, content });
const divider = () => ({ type: SEPARATOR, divider: true, spacing: 1 });
const button = (label, id, { emoji, disabled = false } = {}) => ({
  type: BUTTON,
  style: SECONDARY,
  label,
  custom_id: `probe:${id}`,
  ...(emoji ? { emoji: { name: emoji } } : {}),
  disabled,
});
const section = (content, accessory) => ({
  type: SECTION,
  components: [text(content)],
  accessory,
});
const select = (placeholder, id, labels) => ({
  type: ACTION_ROW,
  components: [
    {
      type: STRING_SELECT,
      custom_id: `probe:${id}`,
      placeholder,
      options: labels.map((label, i) => ({ label, value: `v${i}` })),
    },
  ],
});
const container = (components, accent = BLURPLE) => ({
  type: CONTAINER,
  accent_color: accent,
  components,
});

/** Count components the way Discord's 40-component budget does (nested ones too). */
function countComponents(list) {
  let n = 0;
  for (const c of list) {
    n += 1;
    if (Array.isArray(c.components)) n += countComponents(c.components);
    if (c.accessory) n += 1;
  }
  return n;
}

const serverMessage = (statusLine = "🟢 Online · 1/10 players · queue 0") =>
  container([
    section(
      `### Rusty Probe Server\n${statusLine}\n-# Team: 🟢 probe`,
      button("Refresh", "srv", { emoji: "🔄" }),
    ),
  ]);

const switchesMessage = (label = (s) => s) =>
  container([
    text("### 🔌 Switches"),
    divider(),
    section(
      "🔌 **Front gate** · 🟢 On\n-# auto-off after 30s",
      button(label("Turn off"), "a", { emoji: "❌" }),
    ),
    section(
      "🔌 **Furnaces** · ⏳ Switching on…",
      button(label("Waiting…"), "b", { emoji: "⏳", disabled: true }),
    ),
    section("🔌 **Test** · ⚪ Unknown", button(label("Refresh"), "c", { emoji: "🔄" })),
    section("🔌 **Turrets** (3) · 🔴 Off", button(label("Turn on"), "d", { emoji: "✅" })),
    divider(),
    select("Manage a switch…", "sw", ["Front gate", "Furnaces", "Test", "Turrets"]),
  ]);

const alarmsMessage = () =>
  container([
    text("### 🔔 Alarms"),
    text("🔔 **Front door** · quiet · paging on\n🔔 **Roof** · quiet · paging off"),
    select("Manage an alarm…", "al", ["Front door", "Roof"]),
  ]);

const alarmsTextOnly = () =>
  container([
    text("### 🔔 Alarms"),
    text("🔔 **Front door** · quiet · paging on\n🔔 **Roof** · quiet · paging off"),
  ]);

const storageMessage = () =>
  container([
    text("### 📦 Storage"),
    section(
      "📦 **TC** · 7/29 slots · 🛡️ upkeep ends <t:" +
        Math.floor(Date.now() / 1000 + 2 * 86400) +
        ":R> · 👁 watching\n-# Wood ×2,900 · Stones ×448 · Metal Fragments ×100 · +2 more",
      button("Contents", "st", { emoji: "🔍" }),
    ),
    select("Manage a monitor…", "mo", ["TC"]),
  ]);

// ---------------------------------------------------------------------------
// A tiny PNG encoder for the banner strip (solid colour), so the script needs no
// image file or dependency.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}
function solidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Variants

const VARIANTS = {
  async width() {
    const sections = await post([serverMessage()]);
    record("width", "server header (one Section + button)", describe(sections));
    const sw = await post([switchesMessage()]);
    record("width", "switches (Sections + select)", describe(sw));
    const textOnly = await post([alarmsTextOnly()]);
    record("width", "text-only container (alarms, no select)", describe(textOnly));
    record(
      "width",
      "LOOK",
      "do the Section containers fill the 600 px max? does the text-only one shrink to its content? (desktop + mobile)",
    );
  },

  async banner() {
    const png = solidPng(600, 8, [0x58, 0x65, 0xf2]);
    const strip = {
      type: MEDIA_GALLERY,
      items: [{ media: { url: "attachment://banner.png" } }],
    };
    const res = await post([container([strip, ...alarmsTextOnly().components])], {
      files: [{ name: "banner.png", type: "image/png", data: png }],
    });
    record("banner", "text-only container with a 600×8 MediaGallery strip", describe(res));
    record(
      "banner",
      "LOOK",
      "does the strip force the container to full width? how tall does it render?",
    );
  },

  async grouping() {
    const ids = [];
    for (const [name, build] of [
      ["server", () => serverMessage()],
      ["switches", () => switchesMessage()],
      ["alarms", () => alarmsMessage()],
      ["storage", () => storageMessage()],
    ]) {
      const res = await post([build()]);
      record("grouping", `post ${name}`, describe(res));
      if (res.ok) ids.push(res.body.id);
    }
    await sleep(3000);
    if (ids.length === 4) {
      const res = await edit(ids[0], [serverMessage("🟡 Reconnecting… · 1/10 players · queue 0")]);
      record("grouping", "edit server message after 3 s", describe(res));
      const res2 = await edit(ids[1], [switchesMessage()]);
      record("grouping", "edit switches message after 3 s", describe(res2));
    }
    record(
      "grouping",
      "LOOK",
      "do the four messages share one author header? still after the edits? ('(edited)' placement?)",
    );
  },

  async labels() {
    // U+2800 BRAILLE PATTERN BLANK pads every label to the longest one.
    const words = ["Turn on", "Turn off", "Waiting…", "Refresh", "Contents"];
    const longest = Math.max(...words.map((w) => w.length));
    const pad = (w) => w + "⠀".repeat(longest - w.length);
    const plain = await post([switchesMessage()]);
    record("labels", "unpadded labels", describe(plain));
    const padded = await post([switchesMessage(pad)]);
    record("labels", "labels padded with U+2800", describe(padded));
    record(
      "labels",
      "LOOK",
      "are the padded buttons even in width, or is the padding trimmed? on every client?",
    );
  },

  async emoji() {
    const row = (id, label, emoji, disabled) =>
      section(`**${label}**`, button(label, id, { emoji, disabled }));
    const res = await post([
      container([
        text("### Emoji on grey (Secondary) buttons"),
        row("e1", "Turn on", "✅"),
        row("e2", "Turn off", "❌"),
        row("e3", "Waiting…", "⏳", true),
        row("e4", "Refresh", "🔄"),
        row("e5", "Contents", "🔍"),
      ]),
    ]);
    record("emoji", "five Secondary buttons with emoji", describe(res));
    record(
      "emoji",
      "LOOK",
      "do the emoji render in Discord's style and read well on grey, desktop + mobile?",
    );
  },

  async budgets() {
    const texts = (n) => Array.from({ length: n }, (_, i) => text(`line ${i + 1}`));
    const forty = [container(texts(39))];
    const fortyOne = [container(texts(40))];
    record(
      "budgets",
      `40 components (counted ${countComponents(forty)})`,
      describe(await post(forty)),
    );
    record(
      "budgets",
      `41 components (counted ${countComponents(fortyOne)})`,
      describe(await post(fortyOne)),
    );

    const chars = (n) => [container([text("x".repeat(n))])];
    record("budgets", "4,000 characters of text", describe(await post(chars(4000))));
    record("budgets", "4,001 characters of text", describe(await post(chars(4001))));
    const split = [container([text("y".repeat(2000)), text("z".repeat(2001))])];
    record("budgets", "4,001 characters across two text displays", describe(await post(split)));
  },
};

async function editCap(messageId, maxEdits) {
  const res = await rest("GET", `/channels/${channelId}/messages/${messageId}`);
  if (!res.ok) {
    record("edit-cap", "fetch message", describe(res));
    return;
  }
  const ageMin = Math.round((Date.now() - Date.parse(res.body.timestamp)) / 60000);
  record(
    "edit-cap",
    "message age",
    `${ageMin} min${ageMin < 60 ? " (younger than 1 h: the cap does not apply yet)" : ""}`,
  );
  for (let i = 1; i <= maxEdits; i++) {
    const r = await edit(messageId, [
      container([text(`edit ${i} at ${new Date().toISOString()}`)]),
    ]);
    if (!r.ok) {
      record("edit-cap", `edit ${i}`, describe(r));
      return;
    }
    if (i % 10 === 0) console.log(`  ${i} edits ok`);
    await sleep(1000);
  }
  record("edit-cap", `edits`, `${maxEdits} edits accepted, no 30046`);
}

// ---------------------------------------------------------------------------

const [mode = "all", ...rest_] = process.argv.slice(2);
if (mode === "edit-cap") {
  const [messageId, max = "500"] = rest_;
  if (!messageId) {
    console.error("usage: node scripts/cv2-layout-probe.mjs edit-cap <messageId> [maxEdits]");
    process.exit(2);
  }
  await editCap(messageId, Number(max));
} else if (mode === "all") {
  for (const run of Object.values(VARIANTS)) await run();
} else if (VARIANTS[mode]) {
  await VARIANTS[mode]();
} else {
  console.error(
    `unknown variant "${mode}"; one of: all, ${Object.keys(VARIANTS).join(", ")}, edit-cap`,
  );
  process.exit(2);
}

console.log("\n#### Results\n");
console.log("| Variant | Check | Outcome |\n|---|---|---|");
for (const r of results)
  console.log(`| ${r.variant} | ${r.check} | ${r.outcome.replaceAll("|", "\\|")} |`);
