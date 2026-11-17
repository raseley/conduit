/**
 * Panel-id persistence seam.
 *
 * A server's Conduit Panel is a fixed group of long-lived messages (one per
 * device type) identified by stored ids (`PairedServer.panelMessageIds`).
 * The adapter writes these back so the panel survives restarts and is edited
 * in place rather than reposted. It also persists a storage monitor's Watch
 * flag, and clears the deprecated per-device panel ids once their old messages
 * are deleted (the one-time migration to the Conduit Panel). The Setup hub, pairing and
 * settings panels are ephemeral and are not persisted.
 *
 * The adapter must not reach past bot-core, and depends on this narrow
 * interface rather than on bot-core's class, so it stays testable. The desktop
 * host wires an implementation backed by bot-core's setters
 * (`setServerPanelIds`, `clearLegacyPanelIds`, `setEntityWatch`). A no-op
 * implementation ships so the adapter degrades gracefully (the panel works
 * in-session but is posted afresh after a restart) when the host has not wired
 * persistence.
 */

import type { LegacyPanelIds, ServerPanelIds } from "@conduit/bot-core";

/** The minimal persistence surface the adapter needs for panel message ids. */
export interface PanelStore {
  /** Persist (or clear, when `undefined`) the message ids of a server's Conduit Panel. */
  setServerPanelIds(serverId: string, ids: ServerPanelIds | undefined): Promise<void>;

  /** Clear deprecated per-device panel ids whose old messages are gone. */
  clearLegacyPanelIds(serverId: string, legacy: LegacyPanelIds): Promise<void>;

  /** Persist a storage monitor's `watchChanges` opt-in flag. */
  setEntityWatch(serverId: string, entityId: number, watch: boolean): Promise<void>;
}

/**
 * A {@link PanelStore} that persists nothing. The adapter still functions within
 * a session (it holds panel ids in memory); after a restart, the panel is posted
 * afresh. Used as a default and in tests that don't assert persistence.
 */
export class NoopPanelStore implements PanelStore {
  async setServerPanelIds(): Promise<void> {}
  async clearLegacyPanelIds(): Promise<void> {}
  async setEntityWatch(): Promise<void> {}
}
