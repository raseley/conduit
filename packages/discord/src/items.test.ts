import { describe, expect, it } from "vitest";

import { ITEM_NAMES } from "./item-names.js";
import { itemName } from "./items.js";

describe("itemName", () => {
  it("names the upkeep and common base items by their game display names", () => {
    expect(itemName(-151838493)).toBe("Wood");
    expect(itemName(-2099697608)).toBe("Stones");
    expect(itemName(69511070)).toBe("Metal Fragments");
    expect(itemName(317398316)).toBe("High Quality Metal");
  });

  it("falls back to #id for an id the table does not know", () => {
    expect(itemName(123)).toBe("#123");
    expect(itemName(-42)).toBe("#-42");
  });

  it("holds only integer ids with non-empty, trimmed names", () => {
    expect(ITEM_NAMES.size).toBeGreaterThan(1000);
    for (const [id, name] of ITEM_NAMES) {
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(name).not.toBe("");
      expect(name.trim()).toBe(name);
    }
  });
});
