import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { APP_ROLES } from '../auth/jwt-claims';

export const teamInviteResultSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
  appRole: z.enum(APP_ROLES),
  /** False under NoopProvisioningAdapter (no real Supabase project) — nothing was actually emailed. */
  invited: z
    .boolean()
    .describe(
      'False when the provisioning provider is a no-op — the member row exists but no email was sent.',
    ),
});

export type TeamInviteResult = z.infer<typeof teamInviteResultSchema>;

export class TeamInviteResultDto extends createZodDto(teamInviteResultSchema) {}
