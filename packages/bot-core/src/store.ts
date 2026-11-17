/**
 * {@link StateStore} — the persistence seam for `@conduit/bot-core`.
 *
 * bot-core never talks to a database directly; it goes through this async CRUD
 * interface so the storage backend is swappable. This package ships a pure
 * in-memory implementation ({@link InMemoryStateStore}) used by tests and as a
 * default; the desktop app provides a SQLite/JSON-backed + `safeStorage`
 * encrypted implementation later. The interface is therefore
 * deliberately persistence-agnostic and operates only on the serializable
 * shapes in `./types.ts` — no class instances cross it.
 */

import type { AppConfig, PairedEntity, PairedServer, StoredCredentials } from "./types.js";
import { defaultAppConfig } from "./types.js";

/**
 * Most fcm persistent ids a {@link StateStore} keeps. Handled push ids are
 * appended for the app's whole life, so the list is capped: past this many the
 * oldest are evicted first. Google stops redelivering a push within weeks and
 * Rust+ sends a handful a day, so the newest few hundred cover every push that
 * could still be replayed while keeping `state.json` and the push login small.
 */
export const MAX_PERSISTENT_IDS = 500;

/**
 * Append `ids` to `existing` (insertion-ordered, deduped) and keep only the
 * newest {@link MAX_PERSISTENT_IDS}. The shared trim rule for every backend.
 */
export function capPersistentIds(existing: Iterable<string>, ids: Iterable<string>): string[] {
  const merged = new Set(existing);
  for (const id of ids) merged.add(id);
  return [...merged].slice(-MAX_PERSISTENT_IDS);
}

/**
 * Async CRUD over the persisted data model (servers, entities, config,
 * credentials, FCM persistent-ids). All reads/writes are async so a real
 * backend can do I/O; the in-memory impl resolves synchronously.
 */
export interface StateStore {
  /** Rehydrate any in-memory caches from the backing store. Called by `BotCore.start`. */
  load(): Promise<void>;

  /**
   * Wipe ALL persisted state back to a vanilla, just-installed condition: config
   * reset to {@link defaultAppConfig}, every paired server/entity dropped,
   * credentials cleared, and the fcm persistent-id set emptied. Used by the
   * desktop app's "Reset configuration" action. A backend backed by files should
   * delete them so a subsequent `load` finds nothing.
   */
  clear(): Promise<void>;

  // ── config ──────────────────────────────────────────────────────────────
  /** Current config (synchronous snapshot; `load` must have populated it). */
  getConfig(): AppConfig;
  /** Persist the full config object. */
  setConfig(config: AppConfig): Promise<void>;

  // ── servers ─────────────────────────────────────────────────────────────
  listServers(): PairedServer[];
  getServer(serverId: string): PairedServer | undefined;
  upsertServer(server: PairedServer): Promise<void>;
  removeServer(serverId: string): Promise<void>;

  // ── entities ────────────────────────────────────────────────────────────
  listEntities(serverId: string): PairedEntity[];
  getEntity(serverId: string, entityId: number): PairedEntity | undefined;
  upsertEntity(entity: PairedEntity): Promise<void>;
  removeEntity(serverId: string, entityId: number): Promise<void>;

  // ── credentials (encrypted at rest by the backend) ──────────────────────
  getCredentials(): Promise<StoredCredentials | undefined>;
  setCredentials(credentials: StoredCredentials): Promise<void>;

  // ── fcm persistent ids (replay suppression across restarts) ──────────────
  getPersistentIds(): Promise<string[]>;
  /**
   * Record handled push ids. Keeps at most {@link MAX_PERSISTENT_IDS}, evicting
   * the oldest first (see {@link capPersistentIds}).
   */
  addPersistentIds(ids: string[]): Promise<void>;
}

/** Composite key for an entity within a server. */
function entityKey(serverId: string, entityId: number): string {
  return `${serverId}:${entityId}`;
}

/**
 * A pure in-memory {@link StateStore}. Holds everything in maps; nothing is
 * persisted across process restarts. Suitable for tests and as a default when
 * no real backend is wired up. Returned arrays/objects are defensive copies so
 * callers cannot mutate store internals out of band.
 */
export class InMemoryStateStore implements StateStore {
  private config: AppConfig = defaultAppConfig();
  private readonly servers = new Map<string, PairedServer>();
  private readonly entities = new Map<string, PairedEntity>();
  private credentials?: StoredCredentials;
  private persistentIds: string[] = [];

  /**
   * Optionally seed the store (e.g. tests verifying `start()` rehydration).
   * Seed data is deep-cloned so the caller's objects stay independent.
   */
  constructor(seed?: {
    config?: AppConfig;
    servers?: PairedServer[];
    entities?: PairedEntity[];
    credentials?: StoredCredentials;
    persistentIds?: string[];
  }) {
    if (seed?.config) this.config = structuredClone(seed.config);
    for (const s of seed?.servers ?? []) this.servers.set(s.id, structuredClone(s));
    for (const e of seed?.entities ?? [])
      this.entities.set(entityKey(e.serverId, e.entityId), structuredClone(e));
    if (seed?.credentials) this.credentials = structuredClone(seed.credentials);
    this.persistentIds = capPersistentIds([], seed?.persistentIds ?? []);
  }

  async load(): Promise<void> {
    // Nothing to do: state already lives in memory.
  }

  async clear(): Promise<void> {
    this.config = defaultAppConfig();
    this.servers.clear();
    this.entities.clear();
    this.credentials = undefined;
    this.persistentIds = [];
  }

  getConfig(): AppConfig {
    return structuredClone(this.config);
  }

  async setConfig(config: AppConfig): Promise<void> {
    this.config = structuredClone(config);
  }

  listServers(): PairedServer[] {
    return [...this.servers.values()].map((s) => structuredClone(s));
  }

  getServer(serverId: string): PairedServer | undefined {
    const s = this.servers.get(serverId);
    return s ? structuredClone(s) : undefined;
  }

  async upsertServer(server: PairedServer): Promise<void> {
    this.servers.set(server.id, structuredClone(server));
  }

  async removeServer(serverId: string): Promise<void> {
    this.servers.delete(serverId);
    for (const key of [...this.entities.keys()]) {
      if (key.startsWith(`${serverId}:`)) this.entities.delete(key);
    }
  }

  listEntities(serverId: string): PairedEntity[] {
    return [...this.entities.values()]
      .filter((e) => e.serverId === serverId)
      .map((e) => structuredClone(e));
  }

  getEntity(serverId: string, entityId: number): PairedEntity | undefined {
    const e = this.entities.get(entityKey(serverId, entityId));
    return e ? structuredClone(e) : undefined;
  }

  async upsertEntity(entity: PairedEntity): Promise<void> {
    this.entities.set(entityKey(entity.serverId, entity.entityId), structuredClone(entity));
  }

  async removeEntity(serverId: string, entityId: number): Promise<void> {
    this.entities.delete(entityKey(serverId, entityId));
  }

  async getCredentials(): Promise<StoredCredentials | undefined> {
    return this.credentials ? structuredClone(this.credentials) : undefined;
  }

  async setCredentials(credentials: StoredCredentials): Promise<void> {
    this.credentials = structuredClone(credentials);
  }

  async getPersistentIds(): Promise<string[]> {
    return [...this.persistentIds];
  }

  async addPersistentIds(ids: string[]): Promise<void> {
    this.persistentIds = capPersistentIds(this.persistentIds, ids);
  }
}
