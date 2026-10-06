import type { TenantContextService } from '../../tenant-context/tenant-context.service';
import type { BspCredentialsEncryptionService } from '../bsp-credentials-encryption.service';
import {
  ChannelOwnedByAnotherTenantError,
  UnknownConnectedNumberError,
  WhatsappConnectionService,
} from './whatsapp-connection.service';

const TENANT_A = 'tenant-a';

/** Same "call through the real withTenantTx() callback against a fake tx" rationale as customer.service.spec.ts — a mock that never invokes the callback would leave the query logic untested. */
function makeTenantContext(responses: unknown[]): {
  tenantContext: TenantContextService;
  withTenantTx: jest.Mock;
} {
  let call = 0;
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const response = responses[call++];
    const tx = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve(response),
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve(response) }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve(response) }),
        }),
      }),
    };
    return fn(tx);
  });
  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    withTenantTx,
  };
}

/** Raw `encrypt` mock kept separate from the typed service object — asserting on a typed-interface property directly trips @typescript-eslint/unbound-method. */
function makeEncryption(): {
  encryption: BspCredentialsEncryptionService;
  encrypt: jest.Mock;
} {
  const encrypt = jest.fn().mockReturnValue('cipher-blob');
  return {
    encryption: { encrypt } as unknown as BspCredentialsEncryptionService,
    encrypt,
  };
}

describe('WhatsappConnectionService', () => {
  describe('connectNumber', () => {
    it('encrypts the credentials and returns the connected number', async () => {
      const { encryption, encrypt } = makeEncryption();
      const { tenantContext } = makeTenantContext([
        [{ id: 'number-1', phoneNumberId: 'channel-1' }],
      ]);
      const service = new WhatsappConnectionService(tenantContext, encryption);

      const result = await service.connectNumber(TENANT_A, 'channel-1', {
        apiKey: 'channel-api-key',
      });

      expect(result).toEqual({ id: 'number-1', phoneNumberId: 'channel-1' });
      expect(encrypt).toHaveBeenCalledWith({ apiKey: 'channel-api-key' });
    });

    it('throws ChannelOwnedByAnotherTenantError when the conflict update is skipped (row belongs to a different tenant)', async () => {
      const { encryption } = makeEncryption();
      // The `where: eq(tenantId, tenantId)` guard means Postgres's ON
      // CONFLICT DO UPDATE affects zero rows when the existing row belongs
      // to someone else — .returning() comes back empty.
      const { tenantContext } = makeTenantContext([[]]);
      const service = new WhatsappConnectionService(tenantContext, encryption);

      await expect(
        service.connectNumber(TENANT_A, 'channel-1', { apiKey: 'x' }),
      ).rejects.toBeInstanceOf(ChannelOwnedByAnotherTenantError);
    });

    it('writes the connection state on insert AND on the conflict update (Gulf T3), defaulting to active', async () => {
      const { encryption } = makeEncryption();
      const captured: { values?: unknown; set?: unknown }[] = [];
      const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
        const call: { values?: unknown; set?: unknown } = {};
        captured.push(call);
        return fn({
          insert: () => ({
            values: (values: unknown) => {
              call.values = values;
              return {
                onConflictDoUpdate: (config: { set: unknown }) => {
                  call.set = config.set;
                  return { returning: () => Promise.resolve([{ id: 'n1' }]) };
                },
              };
            },
          }),
        });
      });
      const service = new WhatsappConnectionService(
        { withTenantTx } as unknown as TenantContextService,
        encryption,
      );

      await service.connectNumber(TENANT_A, 'pn-1', { accessToken: 't' });
      await service.connectNumber(
        TENANT_A,
        'pn-1',
        { accessToken: 't' },
        { connectionState: 'reconnect_required', connectionError: 'why' },
      );

      expect(captured[0].values).toMatchObject({
        connectionState: 'active',
        connectionError: null,
      });
      expect(captured[0].set).toMatchObject({
        connectionState: 'active',
        connectionError: null,
      });
      expect(captured[1].values).toMatchObject({
        connectionState: 'reconnect_required',
        connectionError: 'why',
      });
      expect(captured[1].set).toMatchObject({
        connectionState: 'reconnect_required',
        connectionError: 'why',
      });
    });
  });

  describe('isConnectedToAnotherTenant', () => {
    it('is true when a row for the number exists under another tenant', async () => {
      const { encryption } = makeEncryption();
      const { tenantContext, withTenantTx } = makeTenantContext([
        [{ id: 'theirs' }],
      ]);
      const service = new WhatsappConnectionService(tenantContext, encryption);

      await expect(
        service.isConnectedToAnotherTenant(TENANT_A, 'pn-1'),
      ).resolves.toBe(true);
      expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
    });

    it('is false otherwise', async () => {
      const { encryption } = makeEncryption();
      const { tenantContext } = makeTenantContext([[]]);
      const service = new WhatsappConnectionService(tenantContext, encryption);
      await expect(
        service.isConnectedToAnotherTenant(TENANT_A, 'pn-1'),
      ).resolves.toBe(false);
    });
  });

  describe('getStoredPin', () => {
    function withDecrypt(payload: Record<string, unknown>) {
      return {
        encrypt: jest.fn(),
        decrypt: jest.fn().mockReturnValue(payload),
      } as unknown as BspCredentialsEncryptionService;
    }

    it("returns this tenant's stored 6-digit PIN", async () => {
      const { tenantContext } = makeTenantContext([[{ encrypted: 'blob' }]]);
      const service = new WhatsappConnectionService(
        tenantContext,
        withDecrypt({ accessToken: 't', pin: '123456' }),
      );
      await expect(service.getStoredPin(TENANT_A, 'pn-1')).resolves.toBe(
        '123456',
      );
    });

    it('returns null with no row, no PIN, or a malformed PIN', async () => {
      const none = new WhatsappConnectionService(
        makeTenantContext([[]]).tenantContext,
        withDecrypt({}),
      );
      await expect(none.getStoredPin(TENANT_A, 'pn-1')).resolves.toBeNull();

      const nullPin = new WhatsappConnectionService(
        makeTenantContext([[{ encrypted: 'blob' }]]).tenantContext,
        withDecrypt({ pin: null }),
      );
      await expect(nullPin.getStoredPin(TENANT_A, 'pn-1')).resolves.toBeNull();

      const bad = new WhatsappConnectionService(
        makeTenantContext([[{ encrypted: 'blob' }]]).tenantContext,
        withDecrypt({ pin: '12' }),
      );
      await expect(bad.getStoredPin(TENANT_A, 'pn-1')).resolves.toBeNull();
    });
  });

  describe('getOwnedNumber', () => {
    it('returns the row scoped to id + tenantId', async () => {
      const { encryption } = makeEncryption();
      const { tenantContext, withTenantTx } = makeTenantContext([
        [{ id: 'number-1', phoneNumberId: 'channel-1' }],
      ]);
      const service = new WhatsappConnectionService(tenantContext, encryption);

      const result = await service.getOwnedNumber(TENANT_A, 'number-1');

      expect(result).toEqual({ id: 'number-1', phoneNumberId: 'channel-1' });
      expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
    });

    it('throws UnknownConnectedNumberError when no row matches', async () => {
      const { encryption } = makeEncryption();
      const { tenantContext } = makeTenantContext([[]]);
      const service = new WhatsappConnectionService(tenantContext, encryption);

      await expect(
        service.getOwnedNumber(TENANT_A, 'missing'),
      ).rejects.toBeInstanceOf(UnknownConnectedNumberError);
    });
  });

  describe('replaceCredentials', () => {
    it('encrypts and updates, scoped to id + tenantId', async () => {
      const { encryption, encrypt } = makeEncryption();
      const { tenantContext } = makeTenantContext([
        [{ id: 'number-1', phoneNumberId: 'channel-1' }],
      ]);
      const service = new WhatsappConnectionService(tenantContext, encryption);

      const result = await service.replaceCredentials(TENANT_A, 'number-1', {
        apiKey: 'new-key',
      });

      expect(result).toEqual({ id: 'number-1', phoneNumberId: 'channel-1' });
      expect(encrypt).toHaveBeenCalledWith({ apiKey: 'new-key' });
    });

    it('throws UnknownConnectedNumberError when the number is not owned by this tenant', async () => {
      const { encryption } = makeEncryption();
      const { tenantContext } = makeTenantContext([[]]);
      const service = new WhatsappConnectionService(tenantContext, encryption);

      await expect(
        service.replaceCredentials(TENANT_A, 'not-mine', { apiKey: 'x' }),
      ).rejects.toBeInstanceOf(UnknownConnectedNumberError);
    });
  });
});
