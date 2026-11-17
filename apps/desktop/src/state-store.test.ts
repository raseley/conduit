import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AppConfig, PairedEntity, PairedServer, StoredCredentials } from "@conduit/bot-core";
import { MAX_PERSISTENT_IDS } from "@conduit/bot-core";

import { PersistentStateStore, SecureStorageUnavailableError } from "./state-store.js";
import { FakeSecretBox } from "./secret-box.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "conduit-store-"));
}

function makeServer(id: string): PairedServer {
  return {
    id,
    name: `Server ${id}`,
    desc: "desc",
    ip: "1.2.3.4",
    port: 28017,
    playerId: "765611980000000",
    playerToken: "PLAYER_TOKEN_SECRET",
    addedAt: new Date(0).toISOString(),
  };
}

function makeEntity(serverId: string, entityId: number): PairedEntity {
  return { serverId, entityId, entityType: "switch", label: `e${entityId}` };
}

function makeCreds(): StoredCredentials {
  return {
    fcm: {
      fcm: { token: "FCMTOK" },
      gcm: { androidId: "123" },
      expoPushToken: "ExponentPushToken[abc]",
      steamAuthToken: "STEAM_AUTH_TOKEN_SUPER_SECRET",
      steamTokenExpiresAt: new Date(0).toISOString(),
    },
    discordBotToken: "DISCORD_BOT_TOKEN_SECRET",
    steamTokenExpiresAt: new Date(0).toISOString(),
  };
}

const PUSHOVER = {
  appToken: "PUSHOVER_APP_TOKEN_SECRET",
  userKey: "PUSHOVER_USER_KEY_SECRET",
};

/** Decrypt `credentials.bin` in `dir` (written through a {@link FakeSecretBox}). */
async function readSecrets(dir: string): Promise<Record<string, any>> {
  const cipher = await fs.readFile(path.join(dir, "credentials.bin"));
  return JSON.parse(new FakeSecretBox().decrypt(cipher)) as Record<string, any>;
}

// These tests write real files in a temp dir. They take ~15 ms each, but a CI runner's
// disk can stall for seconds (one run took 8.7 s), so allow more than vitest's 5 s.
const REAL_FS_TIMEOUT_MS = 30_000;

describe("PersistentStateStore", { timeout: REAL_FS_TIMEOUT_MS }, () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tmpDir();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips config, servers, entities, persistentIds across a reload", async () => {
    const s1 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s1.load();

    const config: AppConfig = {
      startOnLogin: true,
      controlChannelId: "chan-1",
      roleCapabilities: { admin: ["r1"], user: ["r2"] },
    };
    await s1.setConfig(config);
    await s1.upsertServer(makeServer("srv-a"));
    await s1.upsertServer(makeServer("srv-b"));
    await s1.upsertEntity(makeEntity("srv-a", 100));
    await s1.upsertEntity(makeEntity("srv-a", 101));
    await s1.addPersistentIds(["id1", "id2"]);
    await s1.addPersistentIds(["id2", "id3"]); // dedupe

    // Fresh instance reads the same dir.
    const s2 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s2.load();

    expect(s2.getConfig()).toEqual(config);
    expect(
      s2
        .listServers()
        .map((x) => x.id)
        .sort(),
    ).toEqual(["srv-a", "srv-b"]);
    expect(
      s2
        .listEntities("srv-a")
        .map((e) => e.entityId)
        .sort(),
    ).toEqual([100, 101]);
    expect((await s2.getPersistentIds()).sort()).toEqual(["id1", "id2", "id3"]);
  });

  it("caps persistentIds at MAX_PERSISTENT_IDS, evicting the oldest, across a reload", async () => {
    const s1 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s1.load();
    const ids = Array.from({ length: MAX_PERSISTENT_IDS + 2 }, (_, i) => `id${i}`);
    await s1.addPersistentIds(ids);

    const s2 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s2.load();
    const kept = await s2.getPersistentIds();
    expect(kept).toHaveLength(MAX_PERSISTENT_IDS);
    expect(kept).toEqual(ids.slice(2));
  });

  it("keeps an entity id above 2^32 exactly across a reload", async () => {
    const big = 2 ** 32 + 5;
    const s1 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s1.load();
    await s1.upsertEntity(makeEntity("srv-a", big));

    const s2 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s2.load();
    expect(s2.getEntity("srv-a", big)?.entityId).toBe(big);
  });

  // Live test 2026-11-16: an entity pairing push saved its push id and the new
  // device at the same moment; the second rename failed with EPERM.
  it("runs concurrent saves one at a time, and the file ends with every change", async () => {
    let renaming = 0;
    const rename = async (from: string, to: string): Promise<void> => {
      // Windows refuses a rename while another rename of the file is underway.
      if (renaming > 0) throw Object.assign(new Error("EPERM: rename"), { code: "EPERM" });
      renaming += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await fs.rename(from, to);
      } finally {
        renaming -= 1;
      }
    };
    const s1 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox(), rename });
    await s1.load();

    await Promise.all([
      s1.addPersistentIds(["push-1"]),
      s1.upsertEntity(makeEntity("srv-a", 1)),
      s1.addPersistentIds(["push-2"]),
    ]);

    const s2 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s2.load();
    expect(await s2.getPersistentIds()).toEqual(["push-1", "push-2"]);
    expect(s2.getEntity("srv-a", 1)).toBeDefined();
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("retries a rename the OS briefly refuses", async () => {
    let refusals = 2;
    const rename = async (from: string, to: string): Promise<void> => {
      if (refusals-- > 0) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      await fs.rename(from, to);
    };
    const s = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox(), rename });
    await s.load();

    await s.addPersistentIds(["push-1"]);
    expect(await s.getPersistentIds()).toEqual(["push-1"]);
  });

  it("gives up on a persistent rename failure, removing its temp file", async () => {
    const s = new PersistentStateStore({
      dataDir: dir,
      secretBox: new FakeSecretBox(),
      rename: async () => {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      },
    });
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ version: 1 }));
    await s.load();

    await expect(s.addPersistentIds(["push-1"])).rejects.toThrow("ENOSPC");
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("removes temp files left behind by an earlier run at load", async () => {
    await fs.writeFile(path.join(dir, "state.json.15332.1794855216437.tmp"), "{}");
    await fs.writeFile(path.join(dir, "other.tmp"), "keep");
    const s = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s.load();

    const files = await fs.readdir(dir);
    expect(files).not.toContain("state.json.15332.1794855216437.tmp");
    expect(files).toContain("other.tmp");
  });

  it("clear() waits for a save in flight, so it cannot bring the old state back", async () => {
    const s = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s.load();

    const saving = s.addPersistentIds(["push-1"]);
    await s.clear();
    await saving;

    expect(await fs.readdir(dir)).not.toContain("state.json");
  });

  it("clear() wipes all state + credentials and deletes both backing files", async () => {
    const s1 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s1.load();
    await s1.setConfig({
      startOnLogin: true,
      controlChannelId: "chan-1",
      roleCapabilities: { admin: ["r1"], user: ["r2"] },
    });
    await s1.upsertServer(makeServer("srv-a"));
    await s1.upsertEntity(makeEntity("srv-a", 100));
    await s1.addPersistentIds(["id1"]);
    await s1.setCredentials(makeCreds());

    await s1.clear();

    // In-memory: vanilla defaults, nothing paired, no credentials.
    expect(s1.listServers()).toEqual([]);
    expect(s1.listEntities("srv-a")).toEqual([]);
    expect(await s1.getPersistentIds()).toEqual([]);
    expect(await s1.getCredentials()).toBeUndefined();
    expect(s1.getConfig().controlChannelId).toBeUndefined();

    // On disk: both files are gone.
    await expect(fs.access(path.join(dir, "state.json"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "credentials.bin"))).rejects.toThrow();

    // A fresh instance over the same dir loads an empty, vanilla document.
    const s2 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s2.load();
    expect(s2.listServers()).toEqual([]);
    expect(await s2.getCredentials()).toBeUndefined();
  });

  it("removeServer cascades to its entities", async () => {
    const s = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s.load();
    await s.upsertServer(makeServer("srv-a"));
    await s.upsertEntity(makeEntity("srv-a", 1));
    await s.removeServer("srv-a");
    expect(s.getServer("srv-a")).toBeUndefined();
    expect(s.listEntities("srv-a")).toEqual([]);
  });

  it("encrypts credentials at rest — the raw token never appears on disk", async () => {
    const box = new FakeSecretBox();
    const s = new PersistentStateStore({ dataDir: dir, secretBox: box });
    await s.load();
    const creds = makeCreds();
    await s.setCredentials(creds);

    // The credentials file exists and is NOT plaintext.
    const credFile = path.join(dir, "credentials.bin");
    const bytes = await fs.readFile(credFile);
    const asText = bytes.toString("utf8");
    expect(asText).not.toContain("STEAM_AUTH_TOKEN_SUPER_SECRET");
    expect(asText).not.toContain("DISCORD_BOT_TOKEN_SECRET");
    expect(asText).not.toContain("PLAYER");

    // The non-secret state.json must never contain credential material either.
    const stateText = await fs.readFile(path.join(dir, "state.json"), "utf8");
    expect(stateText).not.toContain("STEAM_AUTH_TOKEN_SUPER_SECRET");
    expect(stateText).not.toContain("DISCORD_BOT_TOKEN_SECRET");

    // And it round-trips back through the box.
    const s2 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s2.load();
    expect(await s2.getCredentials()).toEqual(creds);
  });

  it("keeps player tokens and Pushover keys out of state.json — encrypted at rest", async () => {
    const s = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s.load();
    await s.setCredentials(makeCreds());
    await s.upsertServer(makeServer("srv-a"));
    await s.setConfig({ ...s.getConfig(), pushover: PUSHOVER });

    const stateText = await fs.readFile(path.join(dir, "state.json"), "utf8");
    expect(stateText).not.toContain("PLAYER_TOKEN_SECRET");
    expect(stateText).not.toContain("PUSHOVER_APP_TOKEN_SECRET");
    expect(stateText).not.toContain("PUSHOVER_USER_KEY_SECRET");
    expect(stateText).not.toMatch(/playerToken|pushover|appToken|userKey/);
    // The non-secret server fields stay readable.
    expect(stateText).toContain("Server srv-a");

    const credText = (await fs.readFile(path.join(dir, "credentials.bin"))).toString("utf8");
    expect(credText).not.toContain("PLAYER_TOKEN_SECRET");
    expect(credText).not.toContain("PUSHOVER_APP_TOKEN_SECRET");
    expect(credText).not.toContain("PUSHOVER_USER_KEY_SECRET");
    expect(await readSecrets(dir)).toMatchObject({
      serverSecrets: { "srv-a": { playerToken: "PLAYER_TOKEN_SECRET" } },
      pushover: PUSHOVER,
    });
  });

  it("round-trips player tokens and Pushover keys across a reload", async () => {
    const s1 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s1.load();
    await s1.upsertServer(makeServer("srv-a"));
    await s1.upsertServer({ ...makeServer("srv-b"), playerToken: "OTHER_TOKEN" });
    await s1.setConfig({ ...s1.getConfig(), controlChannelId: "chan-1", pushover: PUSHOVER });
    await s1.setCredentials(makeCreds());

    const s2 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s2.load();
    expect(s2.getServer("srv-a")).toEqual(makeServer("srv-a"));
    expect(s2.getServer("srv-b")?.playerToken).toBe("OTHER_TOKEN");
    expect(s2.getConfig().pushover).toEqual(PUSHOVER);
    expect(s2.getConfig().controlChannelId).toBe("chan-1");
    expect(await s2.getCredentials()).toEqual(makeCreds());

    // Clearing the Pushover keys removes them from the encrypted store as well.
    const { pushover: _pushover, ...withoutPushover } = s2.getConfig();
    await s2.setConfig(withoutPushover);
    const s3 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s3.load();
    expect(s3.getConfig().pushover).toBeUndefined();
    expect((await readSecrets(dir)).pushover).toBeUndefined();
  });

  it("removeServer drops that server's player token from the encrypted store", async () => {
    const s = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s.load();
    await s.upsertServer(makeServer("srv-a"));
    await s.upsertServer({ ...makeServer("srv-b"), playerToken: "OTHER_TOKEN" });

    await s.removeServer("srv-a");

    expect((await readSecrets(dir)).serverSecrets).toEqual({
      "srv-b": { playerToken: "OTHER_TOKEN" },
    });
    const s2 = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s2.load();
    expect(s2.getServer("srv-a")).toBeUndefined();
    expect(s2.getServer("srv-b")?.playerToken).toBe("OTHER_TOKEN");
  });

  it("writes a new token before state.json names its server, and removes it after", async () => {
    const renamed: string[] = [];
    const rename = async (from: string, to: string): Promise<void> => {
      renamed.push(path.basename(to));
      await fs.rename(from, to);
    };
    const s = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox(), rename });
    await s.load();
    renamed.length = 0;

    await s.upsertServer(makeServer("srv-a"));
    expect(renamed).toEqual(["credentials.bin", "state.json"]);

    renamed.length = 0;
    await s.removeServer("srv-a");
    expect(renamed).toEqual(["state.json", "credentials.bin"]);

    // A save that changes no secret leaves credentials.bin alone.
    renamed.length = 0;
    await s.addPersistentIds(["push-1"]);
    expect(renamed).toEqual(["state.json"]);
  });

  it("refuses a new player token or Pushover key when the SecretBox is unavailable, writing no plaintext", async () => {
    const unavailable = new FakeSecretBox();
    Object.defineProperty(unavailable, "isAvailable", { value: () => false });
    const s = new PersistentStateStore({ dataDir: dir, secretBox: unavailable });
    await s.load();

    await expect(s.upsertServer(makeServer("srv-a"))).rejects.toThrow(
      SecureStorageUnavailableError,
    );
    await expect(s.setConfig({ ...s.getConfig(), pushover: PUSHOVER })).rejects.toThrow(
      SecureStorageUnavailableError,
    );
    // Memory is left as it was: no pairing the disk could not keep.
    expect(s.getServer("srv-a")).toBeUndefined();
    expect(s.getConfig().pushover).toBeUndefined();

    // Non-secret changes still save.
    await s.addPersistentIds(["push-1"]);
    await s.upsertEntity(makeEntity("srv-a", 1));

    const stateText = await fs.readFile(path.join(dir, "state.json"), "utf8");
    expect(stateText).toContain("push-1");
    expect(stateText).not.toContain("PLAYER_TOKEN_SECRET");
    expect(stateText).not.toContain("PUSHOVER_APP_TOKEN_SECRET");
    expect(stateText).not.toContain("PUSHOVER_USER_KEY_SECRET");
    expect(await fs.readdir(dir)).not.toContain("credentials.bin");
  });

  it("returns undefined credentials when none are stored", async () => {
    const s = new PersistentStateStore({ dataDir: dir, secretBox: new FakeSecretBox() });
    await s.load();
    expect(await s.getCredentials()).toBeUndefined();
  });

  it("refuses to persist credentials when the SecretBox is unavailable", async () => {
    const unavailable = new FakeSecretBox();
    // Override availability.
    Object.defineProperty(unavailable, "isAvailable", { value: () => false });
    const s = new PersistentStateStore({ dataDir: dir, secretBox: unavailable });
    await s.load();
    await expect(s.setCredentials(makeCreds())).rejects.toThrow(/secure storage/i);
  });
});
