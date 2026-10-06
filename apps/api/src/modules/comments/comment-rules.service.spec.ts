import type { TenantContextService } from '../tenant-context/tenant-context.service';
import type { SocialChannelDirectory } from '../meta-channel/social-channel-directory.service';
import { CommentChannelNotConnectedError } from './comment.errors';
import {
  CommentRulesService,
  DEFAULT_COMMENT_SETTINGS,
  effectiveRules,
} from './comment-rules.service';

describe('effectiveRules', () => {
  const on = { ...DEFAULT_COMMENT_SETTINGS, enabled: true };

  it('is inactive while the tenant has not turned automation on', () => {
    expect(effectiveRules(DEFAULT_COMMENT_SETTINGS, null).active).toBe(false);
    expect(
      effectiveRules(DEFAULT_COMMENT_SETTINGS, {
        enabled: true,
        publicReplyTemplate: null,
      }).active,
    ).toBe(false);
  });

  it("scope 'all' answers every post except a disabled one", () => {
    expect(effectiveRules(on, null).active).toBe(true);
    expect(
      effectiveRules(on, { enabled: false, publicReplyTemplate: null }).active,
    ).toBe(false);
  });

  it("scope 'selected' answers only posts enabled by a rule", () => {
    const selected = { ...on, postScope: 'selected' as const };
    expect(effectiveRules(selected, null).active).toBe(false);
    expect(
      effectiveRules(selected, { enabled: true, publicReplyTemplate: null })
        .active,
    ).toBe(true);
  });

  it('uses the per-post template when one is set', () => {
    expect(
      effectiveRules(on, { enabled: true, publicReplyTemplate: 'DM sent 💬' })
        .publicReplyTemplate,
    ).toBe('DM sent 💬');
    expect(effectiveRules(on, null).publicReplyTemplate).toBe(
      DEFAULT_COMMENT_SETTINGS.publicReplyTemplate,
    );
  });
});

describe('CommentRulesService.upsertPostRule', () => {
  it("refuses a channel account that is not this workspace's", async () => {
    const withTenantTx = jest.fn();
    const service = new CommentRulesService(
      { withTenantTx } as unknown as TenantContextService,
      {
        listForTenant: jest
          .fn()
          .mockResolvedValue([
            { channel: 'messenger', channelAccountId: 'page-mine' },
          ]),
      } as unknown as SocialChannelDirectory,
    );

    await expect(
      service.upsertPostRule('t1', 'u1', {
        channelAccountId: 'page-someone-else',
        postId: 'p1',
        enabled: true,
        publicReplyTemplate: null,
      }),
    ).rejects.toBeInstanceOf(CommentChannelNotConnectedError);
    expect(withTenantTx).not.toHaveBeenCalled();
  });
});
