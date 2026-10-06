import { renderL2TenantPolicySummary } from './l2-tenant-policy-summary';

describe('renderL2TenantPolicySummary()', () => {
  it('lists forbidden topics when present', () => {
    const rendered = renderL2TenantPolicySummary({
      forbiddenTopics: ['refunds', 'competitor pricing'],
      confidenceThreshold: 0.7,
    });

    expect(rendered).toContain('refunds, competitor pricing');
  });

  it('omits the forbidden-topics line entirely when the list is empty', () => {
    const rendered = renderL2TenantPolicySummary({
      forbiddenTopics: [],
      confidenceThreshold: 0.7,
    });

    expect(rendered).not.toContain('Do not discuss');
  });

  it('always includes the low-confidence guidance line', () => {
    const rendered = renderL2TenantPolicySummary({
      forbiddenTopics: [],
      confidenceThreshold: 0.9,
    });

    expect(rendered).toContain('If you are not confident');
  });
});

describe('renderL2TenantPolicySummary() out of hours', () => {
  const base = { forbiddenTopics: [], confidenceThreshold: 0.7 };

  it('says nothing about hours while the tenant is open', () => {
    expect(renderL2TenantPolicySummary(base)).not.toContain('closed');
  });

  it('tells the agent to stop implying someone is reading right now', () => {
    const rendered = renderL2TenantPolicySummary({
      ...base,
      outOfHours: {
        openingHours: 'mon 09:00-17:00 (Asia/Dhaka)',
        response: null,
      },
    });

    expect(rendered).toContain('currently closed');
    expect(rendered).toContain('mon 09:00-17:00 (Asia/Dhaka)');
  });

  it("prefers the tenant's own wording when they set one", () => {
    const rendered = renderL2TenantPolicySummary({
      ...base,
      outOfHours: {
        openingHours: null,
        response: 'We are closed for Eid and reply from Sunday.',
      },
    });

    expect(rendered).toContain('closed for Eid');
    // The platform's default wording is replaced, not appended to it.
    expect(rendered).not.toContain('The business is currently closed.');
  });
});
