// Gulf T5 (D5): reading one number's health from Graph. Response bodies are
// Meta's documented examples (Phone Number node, Messaging Limits and
// Health Status docs, developers.facebook.com, checked 2026-09-19).
import {
  MetaGraphError,
  type MetaGraphClient,
} from '../../meta-graph/meta-graph.module';
import {
  HEALTH_FIELDS,
  HEALTH_FIELDS_WITHOUT_NAME_STATUS,
  MetaPhoneNumberHealthReader,
  WABA_FIELDS,
} from './meta-phone-number-health.reader';

const NOW = new Date('2026-09-19T03:00:00Z');

function makeReader(get: jest.Mock) {
  return new MetaPhoneNumberHealthReader({
    get,
  } as unknown as MetaGraphClient);
}

describe('MetaPhoneNumberHealthReader', () => {
  it('requests the health fields with the number token and maps a healthy number', async () => {
    const get = jest.fn().mockResolvedValue({
      id: '106540352242922',
      display_phone_number: '+1 631-555-5555',
      quality_rating: 'GREEN',
      name_status: 'APPROVED',
      whatsapp_business_manager_messaging_limit: 'TIER_250',
      health_status: {
        can_send_message: 'AVAILABLE',
        entities: [
          {
            entity_type: 'PHONE_NUMBER',
            id: '106540352242922',
            can_send_message: 'AVAILABLE',
          },
          { entity_type: 'WABA', id: '1', can_send_message: 'AVAILABLE' },
        ],
      },
    });

    get.mockResolvedValueOnce({
      id: '106540352242922',
      display_phone_number: '+1 631-555-5555',
      verified_name: "Jasper's Market",
      quality_rating: 'GREEN',
      name_status: 'APPROVED',
      whatsapp_business_manager_messaging_limit: 'TIER_250',
      health_status: {
        can_send_message: 'AVAILABLE',
        entities: [],
      },
    });
    get.mockResolvedValueOnce({
      id: 'waba-1',
      primary_funding_id: '1234567890',
      account_review_status: 'APPROVED',
      owner_business_info: { verification_status: 'verified' },
    });

    const snapshot = await makeReader(get).read(
      '106540352242922',
      'waba-1',
      'tok',
      NOW,
    );

    expect(get).toHaveBeenNthCalledWith(1, '106540352242922', 'tok', {
      fields: HEALTH_FIELDS,
    });
    expect(get).toHaveBeenNthCalledWith(2, 'waba-1', 'tok', {
      fields: WABA_FIELDS,
    });
    expect(HEALTH_FIELDS).toContain(
      'whatsapp_business_manager_messaging_limit',
    );
    expect(HEALTH_FIELDS).not.toContain('messaging_limit_tier');
    expect(snapshot).toEqual({
      qualityRating: 'GREEN',
      messagingLimitTier: 'TIER_250',
      nameStatus: 'APPROVED',
      messagingHealth: 'AVAILABLE',
      healthIssues: [],
      displayPhoneNumber: '16315555555',
      verifiedName: "Jasper's Market",
      paymentMethodAttached: true,
      wabaAccountReviewStatus: 'APPROVED',
      businessVerificationStatus: 'verified',
      checkedAt: NOW,
    });
  });

  it('collects BLOCKED errors and LIMITED additional_info as issues', async () => {
    const get = jest.fn().mockResolvedValue({
      quality_rating: 'YELLOW',
      health_status: {
        can_send_message: 'BLOCKED',
        entities: [
          {
            entity_type: 'PHONE_NUMBER',
            can_send_message: 'LIMITED',
            additional_info: [
              'Your display name has not been approved yet. Your message limit will increase after the display name is approved.',
            ],
          },
          {
            entity_type: 'WABA',
            can_send_message: 'BLOCKED',
            errors: [
              {
                error_code: 141006,
                error_description: 'There is an error with the payment method.',
                possible_solution:
                  'Add a valid payment method in WhatsApp Manager.',
              },
            ],
          },
          { entity_type: 'APP', can_send_message: 'AVAILABLE' },
        ],
      },
    });

    const snapshot = await makeReader(get).read('1', null, 'tok', NOW);

    expect(snapshot.messagingHealth).toBe('BLOCKED');
    expect(snapshot.healthIssues).toEqual([
      {
        entityType: 'PHONE_NUMBER',
        severity: 'LIMITED',
        errorCode: null,
        description:
          'Your display name has not been approved yet. Your message limit will increase after the display name is approved.',
        possibleSolution: null,
      },
      {
        entityType: 'WABA',
        severity: 'BLOCKED',
        errorCode: 141006,
        description: 'There is an error with the payment method.',
        possibleSolution: 'Add a valid payment method in WhatsApp Manager.',
      },
    ]);
    expect(snapshot.nameStatus).toBeNull();
    expect(snapshot.messagingLimitTier).toBeNull();
  });

  it('retries without name_status when Meta refuses the beta field (code 100)', async () => {
    const get = jest
      .fn()
      .mockRejectedValueOnce(
        new MetaGraphError(
          400,
          100,
          null,
          'Tried accessing nonexisting field (name_status)',
        ),
      )
      .mockResolvedValueOnce({ quality_rating: 'GREEN' });

    const snapshot = await makeReader(get).read('1', null, 'tok', NOW);

    expect(get).toHaveBeenLastCalledWith('1', 'tok', {
      fields: HEALTH_FIELDS_WITHOUT_NAME_STATUS,
    });
    expect(HEALTH_FIELDS_WITHOUT_NAME_STATUS).not.toContain('name_status');
    expect(snapshot.qualityRating).toBe('GREEN');
  });

  it('propagates a revoked-token error untouched', async () => {
    const error = new MetaGraphError(401, 190, 463, 'expired');
    const get = jest.fn().mockRejectedValue(error);
    await expect(makeReader(get).read('1', null, 'tok', NOW)).rejects.toBe(
      error,
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('reports no payment method when the WABA has no primary_funding_id', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ quality_rating: 'GREEN' })
      .mockResolvedValueOnce({ id: 'waba-1' });
    const snapshot = await makeReader(get).read('1', 'waba-1', 'tok', NOW);
    expect(snapshot.paymentMethodAttached).toBe(false);
  });

  it('leaves the payment method unknown when the WABA read fails or no WABA is known', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ quality_rating: 'GREEN' })
      .mockRejectedValueOnce(
        new MetaGraphError(403, 200, null, 'no permission'),
      );
    const failed = await makeReader(get).read('1', 'waba-1', 'tok', NOW);
    expect(failed.paymentMethodAttached).toBeNull();
    expect(failed.wabaAccountReviewStatus).toBeNull();
    expect(failed.businessVerificationStatus).toBeNull();
    expect(failed.qualityRating).toBe('GREEN');

    const noWaba = jest.fn().mockResolvedValue({ quality_rating: 'GREEN' });
    const unknown = await makeReader(noWaba).read('1', null, 'tok', NOW);
    expect(unknown.paymentMethodAttached).toBeNull();
    expect(unknown.wabaAccountReviewStatus).toBeNull();
    expect(unknown.businessVerificationStatus).toBeNull();
    expect(noWaba).toHaveBeenCalledTimes(1);
  });

  // F19 (D4): the two verification values CampaignEligibilityService gates a
  // MARKETING broadcast on ride on the SAME WABA read, not a new call.
  it('reads account review and business verification from the one WABA call', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ quality_rating: 'GREEN' })
      .mockResolvedValueOnce({
        id: 'waba-1',
        primary_funding_id: '1',
        account_review_status: 'PENDING',
        owner_business_info: { verification_status: 'not_verified' },
      });
    const snapshot = await makeReader(get).read('1', 'waba-1', 'tok', NOW);
    expect(get).toHaveBeenCalledTimes(2);
    expect(WABA_FIELDS).toContain('account_review_status');
    expect(WABA_FIELDS).toContain('owner_business_info{verification_status}');
    expect(snapshot.wabaAccountReviewStatus).toBe('PENDING');
    expect(snapshot.businessVerificationStatus).toBe('not_verified');
  });

  it('leaves verification null when Meta omits or reshapes the fields, rather than failing the read', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ quality_rating: 'GREEN' })
      .mockResolvedValueOnce({
        id: 'waba-1',
        primary_funding_id: '1',
        account_review_status: 42,
        owner_business_info: 'nope',
      });
    const snapshot = await makeReader(get).read('1', 'waba-1', 'tok', NOW);
    expect(snapshot.paymentMethodAttached).toBe(true);
    expect(snapshot.wabaAccountReviewStatus).toBeNull();
    expect(snapshot.businessVerificationStatus).toBeNull();
  });

  it('ignores malformed parts instead of failing the read', async () => {
    const get = jest.fn().mockResolvedValue({
      quality_rating: 7,
      health_status: { can_send_message: 'AVAILABLE', entities: 'nope' },
    });
    const snapshot = await makeReader(get).read('1', null, 'tok', NOW);
    expect(snapshot.qualityRating).toBeNull();
    expect(snapshot.messagingHealth).toBe('AVAILABLE');
    expect(snapshot.healthIssues).toEqual([]);
  });
});
