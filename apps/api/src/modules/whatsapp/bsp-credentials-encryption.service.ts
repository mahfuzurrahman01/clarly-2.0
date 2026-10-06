// Channel (WhatsappModule): encrypts/decrypts per-tenant BSP credentials
// (API key, WABA number ID) before they touch `whatsapp_numbers
// .bsp_credentials_encrypted` (T6: "stored encrypted at rest ... never in a
// shared/platform-level env var once a tenant is live"). AES-256-GCM via
// Node's built-in `crypto` — authenticated encryption, so a tampered
// ciphertext fails to decrypt rather than silently returning garbage.
//
// The encryption KEY itself (BSP_CREDENTIALS_ENCRYPTION_KEY) is exactly the
// kind of platform-level secret T6 says credentials must not be —
// consistent, not contradictory: the key encrypts/decrypts every tenant's
// row, it never IS a tenant's credential.
import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppConfigService } from '../core';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

/** Thrown when a ciphertext fails GCM auth-tag verification — tampered or encrypted under a different key. */
export class CredentialsDecryptionError extends Error {
  constructor() {
    super(
      'Failed to decrypt BSP credentials — ciphertext invalid or key mismatch.',
    );
    this.name = 'CredentialsDecryptionError';
  }
}

@Injectable()
export class BspCredentialsEncryptionService {
  private readonly key: Buffer;

  constructor(config: AppConfigService) {
    this.key = Buffer.from(config.bspCredentialsEncryptionKey, 'base64');
    if (this.key.length !== 32) {
      throw new Error(
        'BSP_CREDENTIALS_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes for AES-256-GCM.',
      );
    }
  }

  /** Encrypts an arbitrary JSON-serializable credentials payload. Returns a single base64 blob (iv + authTag + ciphertext). */
  encrypt(credentials: Record<string, unknown>): string {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
  }

  /** Inverse of encrypt(). Throws CredentialsDecryptionError on tamper/wrong-key, never returns partial/garbage data. */
  decrypt(blob: string): Record<string, unknown> {
    const raw = Buffer.from(blob, 'base64');
    const iv = raw.subarray(0, IV_LENGTH_BYTES);
    const authTag = raw.subarray(
      IV_LENGTH_BYTES,
      IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES,
    );
    const ciphertext = raw.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);

    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new CredentialsDecryptionError();
    }
  }
}
