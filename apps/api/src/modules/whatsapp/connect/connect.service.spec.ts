import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import type { AppLoggerService } from '../../core';
import type { WhatsappNumberDirectory } from '../whatsapp-number-directory.service';
import {
  ConnectService,
  generatePin,
  REGISTER_FAILURE_MESSAGES,
} from './connect.service';
import { EmbeddedSignupError } from './ports/embedded-signup.port';
import {
  ChannelOwnedByAnotherTenantError,
  type WhatsappConnectionService,
} from './whatsapp-connection.service';

const TENANT = 'tenant-1';
const WABA = '102289599326934';
const PHONE = '106540352242922';
const TOKEN = 'BUSINESS-TOKEN-secret';

/** Raw mock fns kept apart from the typed fakes (avoids @typescript-eslint/unbound-method on assertions). */
function makeHarness() {
  const port = {
    exchangeCode: jest.fn().mockResolvedValue(TOKEN),
    inspectGrant: jest.fn().mockResolvedValue({
      valid: true,
      managementWabaIds: [WABA],
      messagingWabaIds: [WABA],
      metaUserId: '122100000000000001',
    }),
    listPhoneNumbers: jest
      .fn()
      .mockResolvedValue([
        { id: PHONE, displayPhoneNumber: '+1 555 0100', isOnBizApp: false },
      ]),
    subscribeApp: jest.fn().mockResolvedValue(undefined),
    registerPhoneNumber: jest.fn().mockResolvedValue(undefined),
  };
  const connection = {
    isConnectedToAnotherTenant: jest.fn().mockResolvedValue(false),
    getStoredPin: jest.fn().mockResolvedValue(null),
    connectNumber: jest.fn(
      (
        _tenantId: string,
        phoneNumberId: string,
        _credentials: Record<string, unknown>,
        status: { connectionState: string; connectionError: string | null },
      ) => Promise.resolve({ id: 'row-1', phoneNumberId, ...status }),
    ),
  };
  const directory = { listForTenant: jest.fn().mockResolvedValue([]) };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new ConnectService(
    directory as unknown as WhatsappNumberDirectory,
    connection as unknown as WhatsappConnectionService,
    port,
    logger as unknown as AppLoggerService,
  );
  return { service, port, connection, directory, logger };
}

const body = { code: 'CODE', wabaId: WABA, phoneNumberId: PHONE };

describe('ConnectService', () => {
  describe('listNumbers', () => {
    it("delegates to WhatsappNumberDirectory scoped to the caller's own tenant", async () => {
      const { service, directory } = makeHarness();
      directory.listForTenant.mockResolvedValue([
        {
          id: 'n1',
          phoneNumberId: 'channel-1',
          connectionState: 'active',
          connectionError: null,
        },
      ]);

      await expect(service.listNumbers(TENANT)).resolves.toEqual([
        {
          id: 'n1',
          phoneNumberId: 'channel-1',
          connectionState: 'active',
          connectionError: null,
        },
      ]);
      expect(directory.listForTenant).toHaveBeenCalledWith(TENANT);
    });
  });

  describe('completeEmbeddedSignup', () => {
    it('happy path: exchange, verify, subscribe, register, store {accessToken, wabaId, pin} as active', async () => {
      const { service, port, connection } = makeHarness();

      const result = await service.completeEmbeddedSignup(TENANT, body);

      expect(result).toEqual({
        id: 'row-1',
        phoneNumberId: PHONE,
        connectionState: 'active',
        connectionError: null,
        coexistence: false,
      });
      expect(port.exchangeCode).toHaveBeenCalledWith('CODE');
      expect(port.inspectGrant).toHaveBeenCalledWith(TOKEN);
      expect(port.listPhoneNumbers).toHaveBeenCalledWith(WABA, TOKEN);
      expect(port.subscribeApp).toHaveBeenCalledWith(WABA, TOKEN);
      const [registeredPhone, pin, registerToken] = port.registerPhoneNumber
        .mock.calls[0] as [string, string, string];
      expect(registeredPhone).toBe(PHONE);
      expect(pin).toMatch(/^\d{6}$/);
      expect(registerToken).toBe(TOKEN);
      expect(connection.connectNumber).toHaveBeenCalledWith(
        TENANT,
        PHONE,
        { accessToken: TOKEN, wabaId: WABA, pin },
        { connectionState: 'active', connectionError: null },
        // Gulf T5: the health webhooks and the deauthorize callback find the
        // number by these.
        {
          wabaId: WABA,
          displayPhoneNumber: '15550100',
          connectedByMetaUserId: '122100000000000001',
        },
      );
      // Order: subscribe before register.
      expect(port.subscribeApp.mock.invocationCallOrder[0]).toBeLessThan(
        port.registerPhoneNumber.mock.invocationCallOrder[0],
      );
    });

    it('works for a trialing tenant: there is no paid-subscription gate (D16)', async () => {
      // ConnectService has no billing dependency at all any more; the only
      // billing check on the route is EntitlementGuard, which admits trials.
      const { service } = makeHarness();
      await expect(
        service.completeEmbeddedSignup('trial-tenant', body),
      ).resolves.toMatchObject({ connectionState: 'active' });
    });

    it('400s on a reused/expired code and stores nothing', async () => {
      const { service, port, connection } = makeHarness();
      port.exchangeCode.mockRejectedValue(
        new EmbeddedSignupError('invalid_code', 'code used'),
      );

      await expect(
        service.completeEmbeddedSignup(TENANT, body),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(port.subscribeApp).not.toHaveBeenCalled();
      expect(connection.connectNumber).not.toHaveBeenCalled();
    });

    it('502s when Meta fails the code exchange for another reason', async () => {
      const { service, port } = makeHarness();
      port.exchangeCode.mockRejectedValue(
        new EmbeddedSignupError('upstream', 'HTTP 500'),
      );
      await expect(
        service.completeEmbeddedSignup(TENANT, body),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it.each([
      [
        'not in management scope',
        { managementWabaIds: [], messagingWabaIds: [WABA] },
      ],
      [
        'not in messaging scope',
        { managementWabaIds: [WABA], messagingWabaIds: [] },
      ],
      [
        'granted to someone else',
        { managementWabaIds: ['999'], messagingWabaIds: ['999'] },
      ],
    ])(
      '403s when the wabaId is %s, with no Graph writes and nothing stored',
      async (_label, grant) => {
        const { service, port, connection } = makeHarness();
        port.inspectGrant.mockResolvedValue({ valid: true, ...grant });

        await expect(
          service.completeEmbeddedSignup(TENANT, body),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(port.subscribeApp).not.toHaveBeenCalled();
        expect(port.registerPhoneNumber).not.toHaveBeenCalled();
        expect(connection.connectNumber).not.toHaveBeenCalled();
      },
    );

    it('403s when the token is invalid or issued to another app', async () => {
      const { service, port } = makeHarness();
      port.inspectGrant.mockResolvedValue({
        valid: false,
        managementWabaIds: [WABA],
        messagingWabaIds: [WABA],
      });
      await expect(
        service.completeEmbeddedSignup(TENANT, body),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403s when the phoneNumberId is not on the WABA, with nothing stored', async () => {
      const { service, port, connection } = makeHarness();
      port.listPhoneNumbers.mockResolvedValue([
        { id: '111', displayPhoneNumber: null, isOnBizApp: false },
      ]);

      await expect(
        service.completeEmbeddedSignup(TENANT, body),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(port.subscribeApp).not.toHaveBeenCalled();
      expect(connection.connectNumber).not.toHaveBeenCalled();
    });

    it('uses the only number on the WABA when phoneNumberId is omitted, and 400s when there is more than one', async () => {
      const { service, connection, port } = makeHarness();
      await service.completeEmbeddedSignup(TENANT, {
        code: 'CODE',
        wabaId: WABA,
      });
      expect(connection.connectNumber).toHaveBeenCalledWith(
        TENANT,
        PHONE,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );

      port.listPhoneNumbers.mockResolvedValue([
        { id: '1', displayPhoneNumber: null, isOnBizApp: false },
        { id: '2', displayPhoneNumber: null, isOnBizApp: false },
      ]);
      await expect(
        service.completeEmbeddedSignup(TENANT, { code: 'C2', wabaId: WABA }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('409s BEFORE any Graph write when another tenant already holds the number', async () => {
      const { service, port, connection } = makeHarness();
      connection.isConnectedToAnotherTenant.mockResolvedValue(true);

      await expect(
        service.completeEmbeddedSignup(TENANT, body),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(connection.isConnectedToAnotherTenant).toHaveBeenCalledWith(
        TENANT,
        PHONE,
      );
      expect(port.subscribeApp).not.toHaveBeenCalled();
      expect(port.registerPhoneNumber).not.toHaveBeenCalled();
      expect(connection.connectNumber).not.toHaveBeenCalled();
    });

    it('409s when the ON CONFLICT hijack guard fires in the race window', async () => {
      const { service, connection } = makeHarness();
      connection.connectNumber.mockRejectedValue(
        new ChannelOwnedByAnotherTenantError(PHONE),
      );
      await expect(
        service.completeEmbeddedSignup(TENANT, body),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('502s and stores nothing when subscribed_apps fails', async () => {
      const { service, port, connection } = makeHarness();
      port.subscribeApp.mockRejectedValue(
        new EmbeddedSignupError('upstream', 'HTTP 500'),
      );
      await expect(
        service.completeEmbeddedSignup(TENANT, body),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(port.registerPhoneNumber).not.toHaveBeenCalled();
      expect(connection.connectNumber).not.toHaveBeenCalled();
    });

    it('treats a Graph timeout as an upstream failure (502), not a 500', async () => {
      const { service, port } = makeHarness();
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      port.inspectGrant.mockRejectedValue(timeout);
      await expect(
        service.completeEmbeddedSignup(TENANT, body),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('register failing after subscribe stores the row as reconnect_required, never active, keeping the PIN', async () => {
      const { service, port, connection } = makeHarness();
      port.registerPhoneNumber.mockRejectedValue(
        new EmbeddedSignupError('upstream', 'HTTP 500'),
      );

      const result = await service.completeEmbeddedSignup(TENANT, body);

      expect(result.connectionState).toBe('reconnect_required');
      expect(result.connectionError).toBe(REGISTER_FAILURE_MESSAGES.upstream);
      const [, , credentials, status] = connection.connectNumber.mock
        .calls[0] as [string, string, { pin: string | null }, unknown];
      expect(status).toEqual({
        connectionState: 'reconnect_required',
        connectionError: REGISTER_FAILURE_MESSAGES.upstream,
      });
      // The PIN may have been applied before the failure: keep it for the retry.
      expect(credentials.pin).toMatch(/^\d{6}$/);
    });

    it('existing-PIN path (D15c): a PIN mismatch stores reconnect_required with the "disable two-step or enter the PIN" reason and no PIN', async () => {
      const { service, port, connection } = makeHarness();
      port.registerPhoneNumber.mockRejectedValue(
        new EmbeddedSignupError('pin_mismatch', '133005'),
      );

      const result = await service.completeEmbeddedSignup(TENANT, body);

      expect(result.connectionState).toBe('reconnect_required');
      expect(result.connectionError).toBe(
        REGISTER_FAILURE_MESSAGES.pin_mismatch,
      );
      expect(result.connectionError).toMatch(/two-step verification/);
      const credentials = connection.connectNumber.mock.calls[0][2] as {
        pin: string | null;
      };
      expect(credentials.pin).toBeNull();
    });

    it('a PIN lockout stores reconnect_required with the wait reason', async () => {
      const { service, port } = makeHarness();
      port.registerPhoneNumber.mockRejectedValue(
        new EmbeddedSignupError('pin_locked', '133008'),
      );
      const result = await service.completeEmbeddedSignup(TENANT, body);
      expect(result.connectionError).toBe(REGISTER_FAILURE_MESSAGES.pin_locked);
    });

    it('registers with the tenant-supplied PIN first, then a stored PIN, else a fresh one', async () => {
      const { service, port, connection } = makeHarness();

      await service.completeEmbeddedSignup(TENANT, { ...body, pin: '123456' });
      expect(port.registerPhoneNumber).toHaveBeenLastCalledWith(
        PHONE,
        '123456',
        TOKEN,
      );
      expect(connection.connectNumber).toHaveBeenLastCalledWith(
        TENANT,
        PHONE,
        expect.objectContaining({ pin: '123456' }),
        expect.anything(),
        expect.anything(),
      );

      connection.getStoredPin.mockResolvedValue('654321');
      await service.completeEmbeddedSignup(TENANT, body);
      expect(connection.getStoredPin).toHaveBeenCalledWith(TENANT, PHONE);
      expect(port.registerPhoneNumber).toHaveBeenLastCalledWith(
        PHONE,
        '654321',
        TOKEN,
      );
    });

    it('coexistence (D13): an is_on_biz_app number is never registered and is stored active with no PIN', async () => {
      const { service, port, connection } = makeHarness();
      port.listPhoneNumbers.mockResolvedValue([
        { id: PHONE, displayPhoneNumber: '+1 555 0100', isOnBizApp: true },
      ]);

      const result = await service.completeEmbeddedSignup(TENANT, body);

      expect(result).toMatchObject({
        connectionState: 'active',
        coexistence: true,
      });
      expect(port.subscribeApp).toHaveBeenCalled();
      expect(port.registerPhoneNumber).not.toHaveBeenCalled();
      expect(connection.connectNumber).toHaveBeenCalledWith(
        TENANT,
        PHONE,
        { accessToken: TOKEN, wabaId: WABA, pin: null },
        { connectionState: 'active', connectionError: null },
        expect.objectContaining({ wabaId: WABA }),
      );
    });

    it('never logs the business token or the PIN', async () => {
      const { service, logger, port } = makeHarness();
      port.registerPhoneNumber.mockRejectedValueOnce(
        new EmbeddedSignupError('upstream', 'HTTP 500'),
      );
      await service.completeEmbeddedSignup(TENANT, { ...body, pin: '424242' });
      await service.completeEmbeddedSignup(TENANT, body);

      const logged = JSON.stringify([
        logger.log.mock.calls,
        logger.warn.mock.calls,
        logger.error.mock.calls,
      ]);
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain('424242');
    });
  });

  describe('generatePin', () => {
    it('always returns exactly six digits', () => {
      for (let i = 0; i < 200; i++) {
        expect(generatePin()).toMatch(/^\d{6}$/);
      }
    });
  });
});
