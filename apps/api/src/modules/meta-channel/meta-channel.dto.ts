// Channel (MetaChannelModule, Feature 16): the console's contract for
// connecting and inspecting Meta social channels. Zod via nestjs-zod, same
// as every other controller in this codebase.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import { SOCIAL_CHANNEL_CONNECTION_STATES } from '../persistence/drizzle/schema';

/** Only the two Meta social channels. WhatsApp is connected through `whatsapp_numbers`, which has genuinely different fields. */
export const SOCIAL_CHANNEL_KINDS = ['messenger', 'instagram'] as const;

/** Upper bound on a Facebook user access token we accept. Real ones are a few hundred chars. */
const MAX_USER_TOKEN_LENGTH = 4096;

/** Gulf T4 (D4), step A: the ONLY token the browser ever sends. */
export const startMetaConnectBodySchema = z.object({
  userAccessToken: z
    .string()
    .min(1)
    .max(MAX_USER_TOKEN_LENGTH)
    .describe(
      'The short-lived user access token from Facebook Login for Business (`authResponse.accessToken`). Exchanged server-side; never stored as-is and never returned.',
    ),
});
export class StartMetaConnectBodyDto extends createZodDto(
  startMetaConnectBodySchema,
) {}

const linkedInstagramSchema = z.object({
  id: z
    .string()
    .describe('Instagram professional account id (the Instagram channel id).'),
  username: z.string().nullable(),
});

export const metaConnectHandshakeSchema = z.object({
  handshakeId: z
    .string()
    .describe(
      'Opaque, single-tenant, single-user reference to this login. Pass it to `POST /channels/meta`. Valid until `expiresAt`.',
    ),
  expiresAt: isoTimestamp(),
  pages: z
    .array(
      z.object({
        id: z.string().describe('Facebook page id (the Messenger channel id).'),
        name: z.string().nullable(),
        instagram: linkedInstagramSchema
          .nullable()
          .describe(
            'The Instagram professional account linked to this page, or null. Only a page with one can connect `instagram`.',
          ),
      }),
    )
    .describe(
      'Every page the logged-in Facebook user has a role on, as Meta reports it. No tokens.',
    ),
});
export class MetaConnectHandshakeDto extends createZodDto(
  metaConnectHandshakeSchema,
) {}

/** base64url of 32 random bytes. */
const HANDSHAKE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Gulf T4 (D4), step B. No token of any kind: the server already holds Meta's. */
export const connectSocialChannelBodySchema = z.object({
  handshakeId: z
    .string()
    .regex(HANDSHAKE_ID_PATTERN, 'Invalid handshakeId.')
    .describe('From `POST /channels/meta/pages`.'),
  pageId: z
    .string()
    .min(1)
    .max(64)
    .describe('One of the page ids returned by `POST /channels/meta/pages`.'),
  channels: z
    .array(z.enum(SOCIAL_CHANNEL_KINDS))
    .min(1)
    .max(SOCIAL_CHANNEL_KINDS.length)
    .describe(
      '`messenger` connects the page itself; `instagram` connects its linked Instagram account (the page must have one). Both may be sent at once.',
    ),
});

export type ConnectSocialChannelBody = z.infer<
  typeof connectSocialChannelBodySchema
>;
export class ConnectSocialChannelBodyDto extends createZodDto(
  connectSocialChannelBodySchema,
) {}

export const socialChannelSchema = z.object({
  id: z.string().uuid(),
  channel: z.enum(SOCIAL_CHANNEL_KINDS),
  channelAccountId: z.string(),
  pageId: z.string(),
  displayName: z.string().nullable(),
  connectionState: z
    .enum(SOCIAL_CHANNEL_CONNECTION_STATES)
    .describe(
      "'reconnect_required' means this channel's access token is dead and could not be renewed. Inbound messages are still received and still reach a human; automated replies stop until the tenant reconnects. Render it as an action, not a warning.",
    ),
  connectionError: z
    .string()
    .nullable()
    .describe(
      'Why it needs reconnecting, in words a tenant admin can act on. Null while connected.',
    ),
  tokenExpiresAt: isoTimestamp()
    .nullable()
    .describe(
      'When the stored token expires, as Meta reports it. Null means Meta gave no expiry (a system-user token) — NOT that it has expired.',
    ),
});

export class SocialChannelDto extends createZodDto(socialChannelSchema) {}
export class SocialChannelListDto extends createZodDto(
  z.array(socialChannelSchema),
) {}
