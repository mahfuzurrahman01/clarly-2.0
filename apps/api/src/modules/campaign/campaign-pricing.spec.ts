import {
  CAMPAIGN_RATES_LAST_CHECKED,
  MARKETING_RATE_USD_BY_PREFIX,
  UNKNOWN_COUNTRY_RATE_USD,
  estimateCampaignCostUsd,
  estimateCostForPhonesUsd,
  estimateMessageCostUsd,
  round4,
} from './campaign-pricing';

describe('campaign-pricing (F19 D3 / Open Question 1)', () => {
  it('prices every GCC prefix from the table', () => {
    expect(estimateMessageCostUsd('+966501234567')).toBe(
      MARKETING_RATE_USD_BY_PREFIX['966'],
    );
    expect(estimateMessageCostUsd('971501234567')).toBe(
      MARKETING_RATE_USD_BY_PREFIX['971'],
    );
    expect(estimateMessageCostUsd('+965 5012 3456')).toBe(
      MARKETING_RATE_USD_BY_PREFIX['965'],
    );
    expect(estimateMessageCostUsd('97450123456')).toBe(
      MARKETING_RATE_USD_BY_PREFIX['974'],
    );
    expect(estimateMessageCostUsd('97333123456')).toBe(
      MARKETING_RATE_USD_BY_PREFIX['973'],
    );
    expect(estimateMessageCostUsd('96891234567')).toBe(
      MARKETING_RATE_USD_BY_PREFIX['968'],
    );
  });

  it('matches the LONGEST prefix, so a 3-digit entry beats a 1-digit one', () => {
    // 1 (US) and 966 (SA) are both in the table; a Saudi number must not be
    // priced as North American just because nothing else starts with 9.
    expect(estimateMessageCostUsd('966501234567')).not.toBe(
      MARKETING_RATE_USD_BY_PREFIX['1'],
    );
    expect(estimateMessageCostUsd('12125550123')).toBe(
      MARKETING_RATE_USD_BY_PREFIX['1'],
    );
  });

  it('falls back to the highest rate in the table for an unknown prefix', () => {
    // 599 (Caribbean Netherlands) is deliberately not in the table.
    expect(estimateMessageCostUsd('+5991234567')).toBe(
      UNKNOWN_COUNTRY_RATE_USD,
    );
  });

  it('keeps the fallback the maximum of the table, so it can never under-estimate', () => {
    for (const rate of Object.values(MARKETING_RATE_USD_BY_PREFIX)) {
      expect(rate).toBeLessThanOrEqual(UNKNOWN_COUNTRY_RATE_USD);
    }
  });

  it('does not throw on a malformed, empty, null or undefined phone', () => {
    expect(estimateMessageCostUsd('')).toBe(UNKNOWN_COUNTRY_RATE_USD);
    expect(estimateMessageCostUsd('   ')).toBe(UNKNOWN_COUNTRY_RATE_USD);
    expect(estimateMessageCostUsd('not-a-phone')).toBe(
      UNKNOWN_COUNTRY_RATE_USD,
    );
    expect(estimateMessageCostUsd(null)).toBe(UNKNOWN_COUNTRY_RATE_USD);
    expect(estimateMessageCostUsd(undefined)).toBe(UNKNOWN_COUNTRY_RATE_USD);
  });

  it('estimates a whole campaign at the over-estimating rate', () => {
    expect(estimateCampaignCostUsd(100)).toBe(
      round4(100 * UNKNOWN_COUNTRY_RATE_USD),
    );
    expect(estimateCampaignCostUsd(0)).toBe(0);
  });

  it('sums known phones individually', () => {
    const phones = ['+966501234567', '+971501234567'];
    expect(estimateCostForPhonesUsd(phones)).toBe(
      round4(
        MARKETING_RATE_USD_BY_PREFIX['966'] +
          MARKETING_RATE_USD_BY_PREFIX['971'],
      ),
    );
    expect(estimateCostForPhonesUsd([])).toBe(0);
  });

  it('rounds to the 4 decimals the money column stores', () => {
    expect(round4(0.123456)).toBe(0.1235);
    expect(round4(1)).toBe(1);
  });

  it('publishes a last-checked date alongside the table', () => {
    expect(CAMPAIGN_RATES_LAST_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
