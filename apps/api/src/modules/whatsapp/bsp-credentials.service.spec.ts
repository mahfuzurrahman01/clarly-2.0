import type { PersistenceService } from '../persistence/persistence.service';
import type { BspCredentialsEncryptionService } from './bsp-credentials-encryption.service';
import {
  BspCredentialsService,
  MalformedBspCredentialsError,
  UnknownBspCredentialsError,
} from './bsp-credentials.service';

describe('BspCredentialsService.getCredential()', () => {
  const runAdminQuery = jest.fn();
  const decrypt = jest.fn();
  const persistence = { runAdminQuery } as unknown as PersistenceService;
  const encryption = { decrypt } as unknown as BspCredentialsEncryptionService;
  const service = new BspCredentialsService(persistence, encryption);

  beforeEach(() => {
    runAdminQuery.mockReset();
    decrypt.mockReset();
  });

  it('decrypts the stored blob and returns the api key', async () => {
    runAdminQuery.mockResolvedValue([{ encrypted: 'cipher-blob' }]);
    decrypt.mockReturnValue({ apiKey: 'channel-api-key' });

    await expect(service.getCredential('P1', 'apiKey')).resolves.toBe(
      'channel-api-key',
    );
    expect(decrypt).toHaveBeenCalledWith('cipher-blob');
  });

  it('throws UnknownBspCredentialsError when no number row exists', async () => {
    runAdminQuery.mockResolvedValue([]);

    await expect(service.getCredential('P1', 'apiKey')).rejects.toBeInstanceOf(
      UnknownBspCredentialsError,
    );
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('throws rather than sending an undefined api key when the payload is malformed', async () => {
    runAdminQuery.mockResolvedValue([{ encrypted: 'cipher-blob' }]);
    decrypt.mockReturnValue({ somethingElse: true });

    await expect(service.getCredential('P1', 'apiKey')).rejects.toBeInstanceOf(
      MalformedBspCredentialsError,
    );
  });

  it('throws rather than sending an empty api key', async () => {
    runAdminQuery.mockResolvedValue([{ encrypted: 'cipher-blob' }]);
    decrypt.mockReturnValue({ apiKey: '' });

    await expect(service.getCredential('P1', 'apiKey')).rejects.toBeInstanceOf(
      MalformedBspCredentialsError,
    );
  });

  it('lets a decryption failure propagate unremapped (tamper/key-mismatch must stay distinguishable)', async () => {
    runAdminQuery.mockResolvedValue([{ encrypted: 'cipher-blob' }]);
    decrypt.mockImplementation(() => {
      throw new Error('CredentialsDecryptionError');
    });

    await expect(service.getCredential('P1', 'apiKey')).rejects.toThrow(
      'CredentialsDecryptionError',
    );
  });
});
