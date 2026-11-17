import { describe, it, expect } from "vitest";

import { FakeSecretBox } from "./secret-box.js";

describe("FakeSecretBox", () => {
  it("round-trips plaintext", () => {
    const box = new FakeSecretBox();
    const secret = "STEAM_AUTH_TOKEN_SUPER_SECRET";
    const cipher = box.encrypt(secret);
    expect(box.decrypt(cipher)).toBe(secret);
  });

  it("produces ciphertext that does not contain the plaintext", () => {
    const box = new FakeSecretBox();
    const secret = "DISCORD_BOT_TOKEN_SECRET";
    const cipher = box.encrypt(secret);
    expect(cipher.toString("utf8")).not.toContain(secret);
    expect(cipher.toString("latin1")).not.toContain(secret);
  });

  it("reports availability", () => {
    expect(new FakeSecretBox().isAvailable()).toBe(true);
  });
});
