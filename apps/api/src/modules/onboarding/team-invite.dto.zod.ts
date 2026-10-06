import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { APP_ROLES } from '../auth/jwt-claims';

export const teamInviteBodySchema = z.object({
  email: z.string().email().describe('Address the invite is sent to.'),
  appRole: z
    .enum(APP_ROLES)
    .describe('Role the invited member receives in this tenant.'),
});

export type TeamInviteBody = z.infer<typeof teamInviteBodySchema>;

export class TeamInviteBodyDto extends createZodDto(teamInviteBodySchema) {}
