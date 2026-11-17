/**
 * {@link SafeStorageSecretBox} — the production {@link SecretBox} backed by
 * Electron `safeStorage` (DPAPI on Windows).
 *
 * This is the ONLY desktop module that calls `safeStorage`. It is thin glue: all
 * the store logic that uses it lives behind the electron-free {@link SecretBox}
 * seam (`secret-box.ts`) and is unit-tested with {@link FakeSecretBox}. We import
 * `safeStorage` from `electron`; that import typechecks against Electron's bundled
 * types without the binary, and is only ever evaluated inside the running app.
 */

import { safeStorage } from "electron";

import type { SecretBox } from "./secret-box.js";

/** Wraps Electron `safeStorage` (OS-backed; DPAPI on Windows) as a {@link SecretBox}. */
export class SafeStorageSecretBox implements SecretBox {
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  encrypt(plaintext: string): Buffer {
    return safeStorage.encryptString(plaintext);
  }

  decrypt(ciphertext: Buffer): string {
    return safeStorage.decryptString(ciphertext);
  }
}
