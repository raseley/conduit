/**
 * {@link BotCorePanelStore} — the desktop's real {@link PanelStore}.
 *
 * `@conduit/discord`'s adapter persists panel message ids through the narrow
 * {@link PanelStore} interface and ships only a {@link NoopPanelStore} default
 * (panels work in-session but are not rebuilt after a restart). bot-core closes
 * the integration gap by exposing panel-id setters; this bridge simply delegates
 * each {@link PanelStore} method to the matching bot-core setter, so panel ids
 * land in the persistent {@link StateStore} and panels survive restarts.
 *
 * It imports neither `electron` nor `discord.js` — just bot-core — so it is fully
 * unit-testable (the test asserts each call reaches the right bot-core setter).
 */

import type { BotCore, LegacyPanelIds, ServerPanelIds } from "@conduit/bot-core";
import type { PanelStore } from "@conduit/discord";

/** A {@link PanelStore} backed by {@link BotCore}'s panel-id setters. */
export class BotCorePanelStore implements PanelStore {
  constructor(private readonly core: BotCore) {}

  setServerPanelIds(serverId: string, ids: ServerPanelIds | undefined): Promise<void> {
    return this.core.setServerPanelIds(serverId, ids);
  }

  clearLegacyPanelIds(serverId: string, legacy: LegacyPanelIds): Promise<void> {
    return this.core.clearLegacyPanelIds(serverId, legacy);
  }

  setEntityWatch(serverId: string, entityId: number, watch: boolean): Promise<void> {
    return this.core.setEntityWatch(serverId, entityId, watch);
  }
}
