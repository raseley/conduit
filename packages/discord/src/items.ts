/**
 * Rust item names. The Rust+ protocol reports a storage monitor's contents as
 * numeric item ids (e.g. `-151838493` for wood); this maps them to the game's
 * display names. The table itself is generated data (`item-names.ts`, from
 * `scripts/gen-items.mjs`); an id it does not know (an item added since) shows
 * as `#<id>`.
 */

import { ITEM_NAMES } from "./item-names.js";

/** The display name of a Rust item, or `#<id>` for an id the table lacks. */
export function itemName(itemId: number): string {
  return ITEM_NAMES.get(itemId) ?? `#${itemId}`;
}
