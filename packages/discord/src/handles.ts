/**
 * Handle registry.
 *
 * Discord caps a component `customId` at 100 characters, but server ids are
 * uuids (36 chars) and entity ids can be large. To keep customIds short and
 * well under the limit we never embed raw ids; instead we embed **short,
 * stable handles** and keep a bidirectional handle↔id map here.
 *
 * Handles are deterministic and content-derived (a short base36 hash of the
 * underlying id) so they survive a process restart: rebuilding panels from
 * stored ids yields the *same* handles, and a customId minted before the
 * restart still resolves afterwards.
 */

/** A short, opaque handle for a server id (uuid) or an entity id (number). */
export type Handle = string;

/**
 * Deterministically derive a short handle from an arbitrary id string. Uses a
 * cheap FNV-1a hash rendered in base36 and truncated — collision-resistant
 * enough for the handful of objects one operator pairs, and stable across
 * restarts. The registry below guards against the (vanishingly rare) collision.
 */
function deriveHandle(id: string): Handle {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    // FNV prime, kept in 32-bit range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 coerces to an unsigned 32-bit int before base36.
  return (hash >>> 0).toString(36);
}

/**
 * Bidirectional registry mapping ids to short handles and back. One instance is
 * held by the adapter; servers and entity ids share the namespace (entity ids
 * are namespaced by their server when registered, so two servers' "entity 5"
 * never clash).
 */
export class HandleRegistry {
  private readonly idToHandle = new Map<string, Handle>();
  private readonly handleToId = new Map<Handle, string>();

  /**
   * Register an id and return its handle, minting a stable one on first sight.
   * Idempotent: the same id always returns the same handle. On the rare hash
   * collision, the handle is salted until unique.
   */
  register(id: string): Handle {
    const existing = this.idToHandle.get(id);
    if (existing) return existing;

    let handle = deriveHandle(id);
    let salt = 0;
    while (this.handleToId.has(handle) && this.handleToId.get(handle) !== id) {
      salt += 1;
      handle = deriveHandle(`${id}#${salt}`);
    }
    this.idToHandle.set(id, handle);
    this.handleToId.set(handle, id);
    return handle;
  }

  /** Look up the handle for an already-registered id, if any. */
  handleFor(id: string): Handle | undefined {
    return this.idToHandle.get(id);
  }

  /** Resolve a handle back to its id, if registered. */
  idFor(handle: Handle): string | undefined {
    return this.handleToId.get(handle);
  }

  /** Namespace an entity id under its server so handles never clash. */
  static entityKey(serverId: string, entityId: number): string {
    return `${serverId}/${entityId}`;
  }

  /**
   * Namespace a switch group id under its server. The `group/` segment
   * keeps it from ever parsing as an entity key, and an entity key from ever
   * parsing as a group key.
   */
  static groupKey(serverId: string, groupId: string): string {
    return `${serverId}/group/${groupId}`;
  }
}
