import { AppConfigService } from '../core';
import {
  BspCredentialsEncryptionService,
  CredentialsDecryptionError,
} from './bsp-credentials-encryption.service';

function makeConfig(keyBase64: string): AppConfigService {
  return { bspCredentialsEncryptionKey: keyBase64 } as AppConfigService;
}

const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

describe('BspCredentialsEncryptionService', () => {
  it('round-trips arbitrary credential payloads', () => {
    const service = new BspCredentialsEncryptionService(makeConfig(VALID_KEY));
    const credentials = { apiKey: 'secret-123', wabaNumberId: '999888777' };

    const encrypted = service.encrypt(credentials);
    const decrypted = service.decrypt(encrypted);

    expect(decrypted).toEqual(credentials);
  });

  it('never emits the plaintext in the encrypted blob', () => {
    const service = new BspCredentialsEncryptionService(makeConfig(VALID_KEY));
    const encrypted = service.encrypt({ apiKey: 'super-secret-value' });

    expect(encrypted).not.toContain('super-secret-value');
  });

  it('produces a different ciphertext each time (random IV, no ECB-style leakage)', () => {
    const service = new BspCredentialsEncryptionService(makeConfig(VALID_KEY));
    const credentials = { apiKey: 'same-value' };

    const first = service.encrypt(credentials);
    const second = service.encrypt(credentials);

    expect(first).not.toBe(second);
  });

  it('throws CredentialsDecryptionError on a tampered ciphertext (GCM auth tag fails)', () => {
    const service = new BspCredentialsEncryptionService(makeConfig(VALID_KEY));
    const encrypted = service.encrypt({ apiKey: 'value' });
    const tampered = encrypted.slice(0, -4) + 'AAAA';

    expect(() => service.decrypt(tampered)).toThrow(CredentialsDecryptionError);
  });

  it('throws CredentialsDecryptionError when decrypted under the wrong key', () => {
    const encryptor = new BspCredentialsEncryptionService(
      makeConfig(VALID_KEY),
    );
    const otherKey = Buffer.alloc(32, 9).toString('base64');
    const decryptor = new BspCredentialsEncryptionService(makeConfig(otherKey));

    const encrypted = encryptor.encrypt({ apiKey: 'value' });

    expect(() => decryptor.decrypt(encrypted)).toThrow(
      CredentialsDecryptionError,
    );
  });

  it('rejects a key that does not decode to 32 bytes at construction', () => {
    expect(
      () => new BspCredentialsEncryptionService(makeConfig('dG9vLXNob3J0')),
    ).toThrow(/32 bytes/);
  });
});
