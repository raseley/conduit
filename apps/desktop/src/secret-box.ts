/**
 * {@link SecretBox} — the encryption seam for credentials at rest (spec §11.6).
 *
 * The desktop app must encrypt {@link StoredCredentials} with Electron
 * `safeStorage` (DPAPI on Windows) and never write them in plaintext. But
 * `safeStorage` only exists at Electron runtime, which the unit tests cannot
 * load. So the {@link PersistentStateStore} depends on this tiny interface
 * instead of on `safeStorage` directly: the real glue (`SafeStorageSecretBox`,
 * in `safe-storage-box.ts`) wraps `safeStorage`; tests inject {@link FakeSecretBox}.
 *
 * This keeps the store (and its credential-encryption logic) fully unit-testable
 * without an Electron binary, while the production path still goes through DPAPI.
 */

/**
 * Symmetric, OS-backed encryption of small secret blobs. `encrypt` returns
 * opaque ciphertext bytes; `decrypt` reverses it. Implementations need not be
 * portable across machines (DPAPI is machine/user-bound by design).
 */
export interface SecretBox {
  /** Whether encryption is actually available (safeStorage can be unavailable). */
  isAvailable(): boolean;
  /** Encrypt UTF-8 plaintext to opaque ciphertext bytes. */
  encrypt(plaintext: string): Buffer;
  /** Decrypt ciphertext produced by {@link encrypt} back to UTF-8 plaintext. */
  decrypt(ciphertext: Buffer): string;
}

/**
 * A test/dev {@link SecretBox} that does NOT use the OS keystore. It applies a
 * reversible, NON-secure obfuscation (XOR + a tag) so that:
 *   - round-tripping works without Electron, and
 *   - the on-disk bytes provably differ from the plaintext (tests assert the raw
 *     token never appears in the file).
 *
 * It is explicitly NOT cryptographically secure and must never ship; production
 * uses {@link SafeStorageSecretBox}. The leading tag lets the store detect when
 * a file was written by the fake vs. the real box and refuse to mix them.
 */
export class FakeSecretBox implements SecretBox {
  static readonly TAG = "CONDUIT-FAKE-BOX\0";

  constructor(private readonly key: number = 0x5a) {}

  isAvailable(): boolean {
    return true;
  }

  encrypt(plaintext: string): Buffer {
    const body = Buffer.from(plaintext, "utf8");
    for (let i = 0; i < body.length; i++) {
      body[i] = body[i]! ^ this.key;
    }
    return Buffer.concat([Buffer.from(FakeSecretBox.TAG, "utf8"), body]);
  }

  decrypt(ciphertext: Buffer): string {
    const tag = Buffer.from(FakeSecretBox.TAG, "utf8");
    const body = Buffer.from(ciphertext.subarray(tag.length));
    for (let i = 0; i < body.length; i++) {
      body[i] = body[i]! ^ this.key;
    }
    return body.toString("utf8");
  }
}
