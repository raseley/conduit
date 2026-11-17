/**
 * {@link PersistentStateStore} — the desktop app's on-disk {@link StateStore}.
 *
 * Implements bot-core's {@link StateStore} contract backed by files under the
 * app data directory (`%APPDATA%/Conduit` at runtime; an injected base dir in
 * tests). State is held in memory and mirrored to disk on every mutation, so the
 * synchronous reads bot-core expects (`getConfig`, `listServers`, …) are served
 * from memory while writes durably persist.
 *
 * ## SQLite vs. JSON — we use JSON.
 * Either is allowed. For a single-operator app the data
 * is tiny (one config object, a handful of paired servers/entities, a set of FCM
 * persistent ids) and there are no relational queries or concurrent writers — so
 * SQLite buys nothing here and costs a fragile native dependency
 * that may be missing in some environments. Keeping it to
 * plain JSON files means module load never touches a native binary and the store
 * is trivially unit-testable.
 *
 * ## Secret encryption.
 * Non-secret state (config, servers, entities, persistent ids) lives in
 * `state.json` as readable JSON. Secrets are NEVER written in plaintext:
 * {@link StoredCredentials}, each paired server's `playerToken` and the Pushover
 * keys (`config.pushover`) are stripped from `state.json` and kept in one
 * {@link SecretsDocument} that goes through the injected {@link SecretBox} (real
 * impl = Electron `safeStorage`/DPAPI); the ciphertext bytes are written to
 * `credentials.bin`. On load the secrets are merged back, so bot-core sees the
 * same `PairedServer`/`AppConfig` shapes as before. The store does not know or
 * care whether the box is the real safeStorage or a fake — that seam is what
 * makes this unit-testable.
 *
 * Saves write `credentials.bin` before `state.json`, holding the union of the
 * old and new secrets until `state.json` is written, so a crash between the two
 * never leaves `state.json` naming a server whose token `credentials.bin` lacks.
 * When the box is unavailable, a change to any secret is refused (memory left
 * as it was) and never falls back to plaintext; changes to non-secret state
 * still save.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type {
  AppConfig,
  PairedEntity,
  PairedServer,
  PushoverConfig,
  StateStore,
  StoredCredentials,
} from "@conduit/bot-core";
import { capPersistentIds, defaultAppConfig } from "@conduit/bot-core";

import type { SecretBox } from "./secret-box.js";

/** The in-memory document: everything bot-core reads, secrets included. */
interface StateDocument {
  version: 1;
  config: AppConfig;
  servers: PairedServer[];
  entities: PairedEntity[];
  persistentIds: string[];
}

/** What `state.json` holds: the {@link StateDocument} with its secrets stripped. */
interface StateFile {
  version: 1;
  config: Omit<AppConfig, "pushover">;
  servers: Omit<PairedServer, "playerToken">[];
  entities: PairedEntity[];
  persistentIds: string[];
}

/** The decrypted payload of `credentials.bin`: every secret the store holds. */
interface SecretsDocument {
  version: 1;
  credentials?: StoredCredentials;
  /** Paired server id → its Rust+ player token. */
  serverSecrets: Record<string, { playerToken: string }>;
  pushover?: PushoverConfig;
}

/** Raised when a secret must be persisted but the OS secure storage is unavailable. */
export class SecureStorageUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Cannot persist secrets: OS secure storage is unavailable.", options);
    this.name = "SecureStorageUnavailableError";
  }
}

const STATE_FILE = "state.json";
const CREDENTIALS_FILE = "credentials.bin";

function entityKey(serverId: string, entityId: number): string {
  return `${serverId}:${entityId}`;
}

/** Build a {@link SecretsDocument} with a fixed key order, so equal secrets serialize equally. */
function secretsDocument(
  credentials: StoredCredentials | undefined,
  serverSecrets: Record<string, { playerToken: string }>,
  pushover: PushoverConfig | undefined,
): SecretsDocument {
  return { version: 1, credentials, serverSecrets, pushover };
}

/** The secrets of `doc` plus `credentials`. */
function secretsOf(doc: StateDocument, credentials?: StoredCredentials): SecretsDocument {
  const serverSecrets: Record<string, { playerToken: string }> = {};
  for (const server of doc.servers) serverSecrets[server.id] = { playerToken: server.playerToken };
  return secretsDocument(credentials, serverSecrets, doc.config.pushover);
}

/** Every secret in either document; `next` wins where both hold one. */
function unionSecrets(previous: SecretsDocument, next: SecretsDocument): SecretsDocument {
  return secretsDocument(
    next.credentials ?? previous.credentials,
    { ...previous.serverSecrets, ...next.serverSecrets },
    next.pushover ?? previous.pushover,
  );
}

/** `doc` without its secrets: what goes to `state.json`. */
function stateFileOf(doc: StateDocument): StateFile {
  const { pushover: _pushover, ...config } = doc.config;
  return {
    ...doc,
    config,
    servers: doc.servers.map(({ playerToken: _playerToken, ...server }) => server),
  };
}

function emptySecrets(): SecretsDocument {
  return secretsDocument(undefined, {}, undefined);
}

function emptyDocument(): StateDocument {
  return {
    version: 1,
    config: defaultAppConfig(),
    servers: [],
    entities: [],
    persistentIds: [],
  };
}

/** Construction options for {@link PersistentStateStore}. */
export interface PersistentStateStoreOptions {
  /** App data directory (runtime: `app.getPath('userData')`; tests: a tmp dir). */
  dataDir: string;
  /** Encryption seam for credentials at rest (real = safeStorage; tests = fake). */
  secretBox: SecretBox;
  /** Rename seam for the atomic write (tests inject failures). Defaults to `fs.rename`. */
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * File-backed {@link StateStore}. Non-secret state in `state.json`; credentials,
 * player tokens and Pushover keys encrypted via {@link SecretBox} into
 * `credentials.bin`.
 */
export class PersistentStateStore implements StateStore {
  private readonly dataDir: string;
  private readonly secretBox: SecretBox;
  private readonly statePath: string;
  private readonly credentialsPath: string;

  private doc: StateDocument = emptyDocument();
  /** In-memory mirror of the decrypted credentials (never written to state.json). */
  private credentials?: StoredCredentials;
  private loaded = false;
  private readonly rename: (from: string, to: string) => Promise<void>;
  /** The last save queued; saves run one at a time. */
  private saving: Promise<void> = Promise.resolve();
  /** The secrets `credentials.bin` holds, as last written or read (JSON). */
  private persistedSecrets = JSON.stringify(emptySecrets());
  /** The `state.json` content as last written; `undefined` = not written by this instance. */
  private persistedState?: string;

  constructor(opts: PersistentStateStoreOptions) {
    this.dataDir = opts.dataDir;
    this.secretBox = opts.secretBox;
    this.rename = opts.rename ?? ((from, to) => fs.rename(from, to));
    this.statePath = path.join(this.dataDir, STATE_FILE);
    this.credentialsPath = path.join(this.dataDir, CREDENTIALS_FILE);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.removeStaleTempFiles();

    let secrets = emptySecrets();
    try {
      const cipher = await fs.readFile(this.credentialsPath);
      const parsed = JSON.parse(this.secretBox.decrypt(cipher)) as Partial<SecretsDocument>;
      secrets = secretsDocument(parsed.credentials, parsed.serverSecrets ?? {}, parsed.pushover);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.credentials = secrets.credentials;
    this.persistedSecrets = JSON.stringify(secrets);
    this.persistedState = undefined;

    let stateMissing = false;
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StateFile>;
      // Secrets come from credentials.bin only.
      const { pushover: _pushover, ...config } = (parsed.config ?? {}) as Partial<AppConfig>;
      this.doc = {
        ...emptyDocument(),
        ...parsed,
        // Merge config so a future field added to defaultAppConfig is present.
        config: {
          ...defaultAppConfig(),
          ...config,
          ...(secrets.pushover ? { pushover: secrets.pushover } : {}),
        },
        servers: (parsed.servers ?? []).map((server) => ({
          ...server,
          playerToken: secrets.serverSecrets[server.id]?.playerToken ?? "",
        })),
        entities: parsed.entities ?? [],
        persistentIds: parsed.persistentIds ?? [],
        version: 1,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.doc = emptyDocument();
      stateMissing = true;
    }
    if (stateMissing) await this.save();

    this.loaded = true;
  }

  /**
   * Wipe everything back to a vanilla state: reset the in-memory document and
   * credentials, then delete both backing files so a subsequent `load` (or a
   * fresh process) finds nothing and re-creates an empty document. `force: true`
   * makes a missing file a no-op.
   */
  async clear(): Promise<void> {
    this.doc = emptyDocument();
    this.credentials = undefined;
    // A save still in flight would otherwise land after the delete and bring
    // the old state back.
    await this.saving.catch(() => {});
    await fs.rm(this.statePath, { force: true });
    await fs.rm(this.credentialsPath, { force: true });
    this.persistedSecrets = JSON.stringify(emptySecrets());
    this.persistedState = undefined;
  }

  // ── config ────────────────────────────────────────────────────────────────

  getConfig(): AppConfig {
    return structuredClone(this.doc.config);
  }

  async setConfig(config: AppConfig): Promise<void> {
    await this.commit(() => {
      this.doc.config = structuredClone(config);
    });
  }

  // ── servers ───────────────────────────────────────────────────────────────

  listServers(): PairedServer[] {
    return this.doc.servers.map((s) => structuredClone(s));
  }

  getServer(serverId: string): PairedServer | undefined {
    const s = this.doc.servers.find((x) => x.id === serverId);
    return s ? structuredClone(s) : undefined;
  }

  async upsertServer(server: PairedServer): Promise<void> {
    await this.commit(() => {
      const idx = this.doc.servers.findIndex((x) => x.id === server.id);
      const copy = structuredClone(server);
      if (idx >= 0) this.doc.servers[idx] = copy;
      else this.doc.servers.push(copy);
    });
  }

  async removeServer(serverId: string): Promise<void> {
    await this.commit(() => {
      this.doc.servers = this.doc.servers.filter((x) => x.id !== serverId);
      this.doc.entities = this.doc.entities.filter((e) => e.serverId !== serverId);
    });
  }

  // ── entities ──────────────────────────────────────────────────────────────

  listEntities(serverId: string): PairedEntity[] {
    return this.doc.entities.filter((e) => e.serverId === serverId).map((e) => structuredClone(e));
  }

  getEntity(serverId: string, entityId: number): PairedEntity | undefined {
    const e = this.doc.entities.find((x) => x.serverId === serverId && x.entityId === entityId);
    return e ? structuredClone(e) : undefined;
  }

  async upsertEntity(entity: PairedEntity): Promise<void> {
    const key = entityKey(entity.serverId, entity.entityId);
    const idx = this.doc.entities.findIndex((x) => entityKey(x.serverId, x.entityId) === key);
    const copy = structuredClone(entity);
    if (idx >= 0) this.doc.entities[idx] = copy;
    else this.doc.entities.push(copy);
    await this.save();
  }

  async removeEntity(serverId: string, entityId: number): Promise<void> {
    const key = entityKey(serverId, entityId);
    this.doc.entities = this.doc.entities.filter((x) => entityKey(x.serverId, x.entityId) !== key);
    await this.save();
  }

  // ── credentials (encrypted at rest) ─────────────────────────────────────────

  async getCredentials(): Promise<StoredCredentials | undefined> {
    return this.credentials ? structuredClone(this.credentials) : undefined;
  }

  async setCredentials(credentials: StoredCredentials): Promise<void> {
    await this.commit(() => {
      this.credentials = structuredClone(credentials);
    });
  }

  // ── fcm persistent ids ──────────────────────────────────────────────────────

  async getPersistentIds(): Promise<string[]> {
    return [...this.doc.persistentIds];
  }

  async addPersistentIds(ids: string[]): Promise<void> {
    this.doc.persistentIds = capPersistentIds(this.doc.persistentIds, ids);
    await this.save();
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Apply `change` to the in-memory state, then save. A change that touches a
   * secret while the {@link SecretBox} is unavailable is undone and refused with
   * {@link SecureStorageUnavailableError}, leaving memory as it was (as
   * `setCredentials` always has): secrets are never written in plaintext.
   */
  private async commit(change: () => void): Promise<void> {
    const before = { doc: structuredClone(this.doc), credentials: this.credentials };
    const secretsBefore = JSON.stringify(secretsOf(this.doc, this.credentials));
    change();
    const secretsAfter = JSON.stringify(secretsOf(this.doc, this.credentials));
    if (secretsAfter !== secretsBefore && !this.secretBox.isAvailable()) {
      this.doc = before.doc;
      this.credentials = before.credentials;
      throw new SecureStorageUnavailableError();
    }
    await this.save();
  }

  /**
   * Save both files, after any save already in flight. Two saves at once (a
   * pairing push persists its id and the new device in the same moment) used
   * to race their renames, and on Windows the second failed with EPERM (seen
   * live, 2026-11-16). The state is read when the save starts, so a save queued
   * behind another carries every change made in between.
   */
  private save(): Promise<void> {
    const next = this.saving
      .catch(() => {
        // The earlier save's failure was reported to its own caller.
      })
      .then(() => this.writeFiles());
    this.saving = next;
    return next;
  }

  /**
   * Write `credentials.bin` holding every secret either the old or the new
   * `state.json` refers to, then `state.json`, then `credentials.bin` with only
   * the current secrets. Adding a secret takes the first write, removing one the
   * last, so a crash in between never leaves `state.json` naming a server whose
   * player token is lost. A file whose content is unchanged is not rewritten.
   */
  private async writeFiles(): Promise<void> {
    if (!this.loaded) {
      // Allow writes before an explicit load (load() is normally called first),
      // but ensure the directory exists.
      await fs.mkdir(this.dataDir, { recursive: true });
    }
    const doc = structuredClone(this.doc);
    const secrets = secretsOf(doc, this.credentials);
    const previous = JSON.parse(this.persistedSecrets) as SecretsDocument;
    await this.writeSecrets(unionSecrets(previous, secrets));
    const state = JSON.stringify(stateFileOf(doc), null, 2);
    if (state !== this.persistedState) {
      await atomicWrite(this.statePath, state, this.rename);
      this.persistedState = state;
    }
    await this.writeSecrets(secrets);
  }

  private async writeSecrets(secrets: SecretsDocument): Promise<void> {
    const json = JSON.stringify(secrets);
    if (json === this.persistedSecrets) return;
    if (!this.secretBox.isAvailable()) throw new SecureStorageUnavailableError();
    await atomicWrite(this.credentialsPath, this.secretBox.encrypt(json), this.rename);
    this.persistedSecrets = json;
  }

  /** Remove temp files a crash or a failed rename left behind. */
  private async removeStaleTempFiles(): Promise<void> {
    const names = await fs.readdir(this.dataDir).catch(() => [] as string[]);
    const stale = names.filter((name) =>
      [STATE_FILE, CREDENTIALS_FILE].some(
        (file) => name.startsWith(`${file}.`) && name.endsWith(".tmp"),
      ),
    );
    await Promise.all(stale.map((name) => fs.rm(path.join(this.dataDir, name), { force: true })));
  }
}

/** Distinguishes temp files of writes started in the same millisecond. */
let tempSequence = 0;

/** Rename errors Windows raises while another process briefly holds the file. */
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 5;

/**
 * Write atomically: write to a temp file then rename, so a crash mid-write can
 * never leave a half-written `state.json`/`credentials.bin`. A rename refused
 * because the file is briefly held (antivirus, the search indexer) is retried
 * with backoff; on giving up, the temp file is removed.
 */
async function atomicWrite(
  target: string,
  data: string | Buffer,
  rename: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.${++tempSequence}.tmp`;
  await fs.writeFile(tmp, data);
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_ERRORS.has(code)) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}
