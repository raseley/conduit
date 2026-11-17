import { describe, it, expect, vi } from "vitest";

import { BotCorePanelStore } from "./panel-store-bridge.js";

/**
 * The bridge must delegate each PanelStore method to the matching BotCore
 * panel-id setter. We pass a stub with spies in place of a real
 * BotCore and assert the delegation + argument forwarding.
 */
describe("BotCorePanelStore", () => {
  function makeCore() {
    return {
      setServerPanelIds: vi.fn().mockResolvedValue(undefined),
      clearLegacyPanelIds: vi.fn().mockResolvedValue(undefined),
      setEntityWatch: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("delegates setServerPanelIds (including clearing with undefined)", async () => {
    const core = makeCore();
    const store = new BotCorePanelStore(core as never);
    await store.setServerPanelIds("srv", { server: "msg-1", switches: ["msg-2"] });
    await store.setServerPanelIds("srv", undefined);
    expect(core.setServerPanelIds.mock.calls).toEqual([
      ["srv", { server: "msg-1", switches: ["msg-2"] }],
      ["srv", undefined],
    ]);
  });

  it("delegates clearLegacyPanelIds", async () => {
    const core = makeCore();
    const store = new BotCorePanelStore(core as never);
    await store.clearLegacyPanelIds("srv", { status: true, entityIds: [42] });
    expect(core.clearLegacyPanelIds).toHaveBeenCalledWith("srv", {
      status: true,
      entityIds: [42],
    });
  });

  it("delegates setEntityWatch", async () => {
    const core = makeCore();
    const store = new BotCorePanelStore(core as never);
    await store.setEntityWatch("srv", 7, true);
    expect(core.setEntityWatch).toHaveBeenCalledWith("srv", 7, true);
  });
});
