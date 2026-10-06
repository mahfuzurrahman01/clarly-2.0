// F19 (D2, D9): the approved-templates-only gate. Every rejection reason
// gets a case, because this is the only thing standing between a merchant
// and a policy violation against their own WABA.
import type { MessageTemplateRecord } from '../templates/message-template.service';
import {
  assertTemplateSendable,
  campaignCategory,
  CampaignTemplateGateError,
} from './campaign-template-gate';
import { MARKETING_OPT_OUT_FRAGMENT } from './marketing-opt-out-fragment';

function template(
  overrides: Partial<MessageTemplateRecord> = {},
): MessageTemplateRecord {
  return {
    id: 'tpl-1',
    kind: 'whatsapp_template',
    name: 'spring_sale',
    language: 'en',
    category: 'MARKETING',
    body: `Hi {{1}}, spring sale is on. ${MARKETING_OPT_OUT_FRAGMENT}`,
    variables: [{ position: 1, label: 'Name', example: 'Sam' }],
    approvalStatus: 'approved',
    approvalDetail: null,
    syncedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MessageTemplateRecord;
}

describe('assertTemplateSendable (D2)', () => {
  it('accepts an approved MARKETING template whose value count matches', () => {
    expect(() => assertTemplateSendable(template(), 1)).not.toThrow();
  });

  it('accepts an approved UTILITY template', () => {
    expect(() =>
      assertTemplateSendable(template({ category: 'UTILITY' }), 1),
    ).not.toThrow();
  });

  it('rejects a canned reply — it cannot be sent outside the service window', () => {
    expect(() =>
      assertTemplateSendable(template({ kind: 'canned_reply' }), 1),
    ).toThrow(CampaignTemplateGateError);
  });

  it.each(['pending', 'rejected', 'paused', 'disabled', 'local'] as const)(
    "rejects approvalStatus=%s and quotes Meta's own detail verbatim",
    (approvalStatus) => {
      expect(() =>
        assertTemplateSendable(
          template({
            approvalStatus:
              approvalStatus as MessageTemplateRecord['approvalStatus'],
            approvalDetail: 'Meta says no',
          }),
          1,
        ),
      ).toThrow(/Meta says no/);
    },
  );

  it('rejects an AUTHENTICATION template — a broadcast of one is a policy violation', () => {
    expect(() =>
      assertTemplateSendable(
        template({ category: 'AUTHENTICATION' as never }),
        1,
      ),
    ).toThrow(/AUTHENTICATION/);
  });

  it('rejects a null category rather than letting it through', () => {
    expect(() =>
      assertTemplateSendable(template({ category: null }), 1),
    ).toThrow(CampaignTemplateGateError);
  });

  it('rejects a value-count mismatch at authoring, not on recipient 1 of 40 000', () => {
    expect(() => assertTemplateSendable(template(), 0)).toThrow(
      /takes 1 value\(s\); 0 were supplied/,
    );
  });

  describe('marketing opt-out instruction', () => {
    it('is not required at authoring time (the first slice contract is unchanged)', () => {
      expect(() =>
        assertTemplateSendable(template({ body: 'Hi {{1}}, sale is on.' }), 1),
      ).not.toThrow();
    });

    it('is required from schedule onward for a MARKETING template', () => {
      expect(() =>
        assertTemplateSendable(template({ body: 'Hi {{1}}, sale is on.' }), 1, {
          requireMarketingOptOut: true,
        }),
      ).toThrow(/opt-out instruction/);
    });

    it('is not required of a UTILITY template', () => {
      expect(() =>
        assertTemplateSendable(
          template({ category: 'UTILITY', body: 'Hi {{1}}, shipped.' }),
          1,
          { requireMarketingOptOut: true },
        ),
      ).not.toThrow();
    });
  });
});

describe('campaignCategory (D4 input)', () => {
  it('reports UTILITY for a utility template', () => {
    expect(campaignCategory(template({ category: 'UTILITY' }))).toBe('UTILITY');
  });

  it('reports MARKETING for anything else — the stricter gate is the safe default', () => {
    expect(campaignCategory(template())).toBe('MARKETING');
    expect(campaignCategory(template({ category: null }))).toBe('MARKETING');
  });
});
