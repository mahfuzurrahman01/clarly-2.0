// Gulf T5 (D5): the WABA health webhook fields on /webhooks/whatsapp.
// Payloads are Meta's own documented examples (webhooks reference,
// developers.facebook.com, checked 2026-09-19) unless a test says otherwise.
import { CONNECTION_REASONS } from './connection-state.policy';
import { parseWabaHealthWebhook } from './waba-health-webhook.parser';

const APP_ID = '5731794616896507';

function body(field: string, value: unknown, entryId = '102290129340398') {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: entryId, time: 1743451903, changes: [{ value, field }] }],
  });
}

const parse = (raw: string | Buffer) =>
  parseWabaHealthWebhook(raw, { appId: APP_ID });

describe('parseWabaHealthWebhook', () => {
  describe('account_update', () => {
    it('ACCOUNT_DELETED disconnects every number on the WABA', () => {
      expect(
        parse(body('account_update', { event: 'ACCOUNT_DELETED' })),
      ).toEqual([
        {
          kind: 'connection',
          wabaId: '102290129340398',
          event: 'ACCOUNT_DELETED',
          transition: {
            kind: 'degrade',
            to: 'disconnected',
            reason: CONNECTION_REASONS.wabaDeleted,
          },
        },
      ]);
    });

    it('ACCOUNT_RESTRICTION restricts, naming the restrictions and when they end', () => {
      const [event] = parse(
        body('account_update', {
          event: 'ACCOUNT_RESTRICTION',
          restriction_info: [
            {
              restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING',
              expiration: 1641330498,
            },
            {
              restriction_type: 'RESTRICTED_ADD_PHONE_NUMBER_ACTION',
              expiration: 1641330498,
            },
          ],
        }),
      );
      expect(event).toMatchObject({
        kind: 'connection',
        wabaId: '102290129340398',
        transition: { kind: 'degrade', to: 'restricted' },
      });
      const reason =
        event.kind === 'connection' && event.transition.kind === 'degrade'
          ? event.transition.reason
          : '';
      expect(reason).toContain('start conversations');
      expect(reason).toContain('add phone numbers');
      expect(reason).toContain('2022-01-04');
    });

    it('ACCOUNT_RESTRICTION with an unknown type still restricts, quoting it', () => {
      const [event] = parse(
        body('account_update', {
          event: 'ACCOUNT_RESTRICTION',
          restriction_info: [{ restriction_type: 'RESTRICTED_SOMETHING_NEW' }],
        }),
      );
      expect(JSON.stringify(event)).toContain('RESTRICTED_SOMETHING_NEW');
    });

    it('DISABLED_UPDATE: DISABLE restricts, REINSTATE restores, SCHEDULE_FOR_DISABLE changes nothing', () => {
      const ban = (state: string) =>
        parse(
          body('account_update', {
            event: 'DISABLED_UPDATE',
            ban_info: {
              waba_ban_state: state,
              waba_ban_date: 'April 17, 2025',
            },
          }),
        );
      expect(ban('DISABLE')).toEqual([
        expect.objectContaining({
          transition: {
            kind: 'degrade',
            to: 'restricted',
            reason: CONNECTION_REASONS.wabaDisabled,
          },
        }),
      ]);
      expect(ban('REINSTATE')).toEqual([
        expect.objectContaining({
          transition: { kind: 'restore', from: ['restricted'] },
        }),
      ]);
      expect(ban('SCHEDULE_FOR_DISABLE')).toEqual([]);
    });

    it('PARTNER_APP_UNINSTALLED for OUR app requires a reconnect, keyed by waba_info.waba_id (entry.id is the partner business)', () => {
      expect(
        parse(
          body(
            'account_update',
            {
              event: 'PARTNER_APP_UNINSTALLED',
              waba_info: {
                waba_id: '184943124712545',
                owner_business_id: '1284923862322270',
                partner_app_id: APP_ID,
              },
            },
            '2949482758682047',
          ),
        ),
      ).toEqual([
        {
          kind: 'connection',
          wabaId: '184943124712545',
          event: 'PARTNER_APP_UNINSTALLED',
          transition: {
            kind: 'degrade',
            to: 'reconnect_required',
            reason: CONNECTION_REASONS.appUninstalled,
          },
        },
      ]);
    });

    it("ignores PARTNER_APP_UNINSTALLED for another partner's app", () => {
      expect(
        parse(
          body('account_update', {
            event: 'PARTNER_APP_UNINSTALLED',
            waba_info: { waba_id: '1', partner_app_id: '999' },
          }),
        ),
      ).toEqual([]);
    });

    it('PARTNER_REMOVED disconnects the WABA named in waba_info', () => {
      expect(
        parse(
          body(
            'account_update',
            {
              event: 'PARTNER_REMOVED',
              waba_info: {
                waba_id: '980198427658004',
                owner_business_id: '2329417887457253',
              },
              disconnection_info: {
                reason: 'PRIMARY_INACTIVITY',
                initiated_by: 'SYSTEM',
              },
            },
            '2949482758682047',
          ),
        ),
      ).toEqual([
        expect.objectContaining({
          wabaId: '980198427658004',
          transition: {
            kind: 'degrade',
            to: 'disconnected',
            reason: CONNECTION_REASONS.partnerRemoved,
          },
        }),
      ]);
    });

    it('ACCOUNT_OFFBOARDED disconnects; ACCOUNT_RECONNECTED restores only a disconnected number', () => {
      expect(
        parse(body('account_update', { event: 'ACCOUNT_OFFBOARDED' })),
      ).toEqual([
        expect.objectContaining({
          transition: {
            kind: 'degrade',
            to: 'disconnected',
            reason: CONNECTION_REASONS.offboarded,
          },
        }),
      ]);
      expect(
        parse(body('account_update', { event: 'ACCOUNT_RECONNECTED' })),
      ).toEqual([
        expect.objectContaining({
          transition: { kind: 'restore', from: ['disconnected'] },
        }),
      ]);
    });

    it.each([
      'ACCOUNT_VIOLATION',
      'PARTNER_ADDED',
      'PARTNER_APP_INSTALLED',
      'VOLUME_BASED_PRICING_TIER_UPDATE',
      'BUSINESS_PRIMARY_LOCATION_COUNTRY_UPDATE',
      'SOMETHING_META_ADDS_LATER',
    ])('%s changes no connection state', (event) => {
      expect(parse(body('account_update', { event }))).toEqual([]);
    });
  });

  describe('phone_number_quality_update', () => {
    it('takes the messaging limit from max_daily_conversations_per_business', () => {
      expect(
        parse(
          body('phone_number_quality_update', {
            display_phone_number: '15550783881',
            event: 'UPGRADE',
            current_limit: 'TIER_250',
            max_daily_conversations_per_business: 'TIER_2K',
          }),
        ),
      ).toEqual([
        { kind: 'messaging_limit', wabaId: '102290129340398', tier: 'TIER_2K' },
      ]);
    });

    it('falls back to the deprecated current_limit for a limit change', () => {
      expect(
        parse(
          body('phone_number_quality_update', {
            display_phone_number: '15550783881',
            event: 'DOWNGRADE',
            current_limit: 'TIER_250',
          }),
        ),
      ).toEqual([
        {
          kind: 'messaging_limit',
          wabaId: '102290129340398',
          tier: 'TIER_250',
        },
      ]);
    });

    it("does not read a throughput upgrade's current_limit as a messaging limit (Meta's documented example)", () => {
      expect(
        parse(
          body(
            'phone_number_quality_update',
            {
              display_phone_number: '15550783881',
              event: 'THROUGHPUT_UPGRADE',
              current_limit: 'TIER_UNLIMITED',
            },
            '102290129340398',
          ),
        ),
      ).toEqual([]);
    });

    it('drops a tier value that is not a TIER_* token', () => {
      expect(
        parse(
          body('phone_number_quality_update', {
            display_phone_number: '1',
            event: 'UPGRADE',
            max_daily_conversations_per_business: 'lots',
          }),
        ),
      ).toEqual([]);
    });
  });

  describe('phone_number_name_update', () => {
    it.each([
      ['APPROVED', 'APPROVED'],
      ['REJECTED', 'DECLINED'],
      ['PENDING', 'PENDING_REVIEW'],
      ['DEFERRED', 'PENDING_REVIEW'],
    ])(
      'maps decision %s to name_status %s, keyed by the digits of the display number',
      (decision, nameStatus) => {
        expect(
          parse(
            body('phone_number_name_update', {
              display_phone_number: '+1 555-078-3881',
              decision,
              requested_verified_name: 'Lucky Shrub',
              rejection_reason: null,
            }),
          ),
        ).toEqual([
          {
            kind: 'name_status',
            wabaId: '102290129340398',
            displayPhoneNumber: '15550783881',
            nameStatus,
          },
        ]);
      },
    );

    it('ignores an unknown decision', () => {
      expect(
        parse(
          body('phone_number_name_update', {
            display_phone_number: '15550783881',
            decision: 'MAYBE',
          }),
        ),
      ).toEqual([]);
    });
  });

  it('returns nothing for a messages webhook, a non-WABA object, malformed JSON or a malformed change', () => {
    expect(
      parse(
        body('messages', {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: '1' },
          messages: [],
        }),
      ),
    ).toEqual([]);
    expect(
      parse(
        JSON.stringify({
          object: 'page',
          entry: [
            {
              id: '1',
              changes: [
                {
                  field: 'account_update',
                  value: { event: 'ACCOUNT_DELETED' },
                },
              ],
            },
          ],
        }),
      ),
    ).toEqual([]);
    expect(parse('{not json')).toEqual([]);
    expect(parse(body('account_update', { event: 42 }))).toEqual([]);
  });

  it('keeps the valid changes of a batch when one is malformed', () => {
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '7',
          changes: [
            { field: 'account_update', value: 'garbage' },
            { field: 'account_update', value: { event: 'ACCOUNT_DELETED' } },
          ],
        },
      ],
    });
    expect(parse(raw)).toHaveLength(1);
  });

  it('accepts a Buffer body', () => {
    expect(
      parse(Buffer.from(body('account_update', { event: 'ACCOUNT_DELETED' }))),
    ).toHaveLength(1);
  });
});
