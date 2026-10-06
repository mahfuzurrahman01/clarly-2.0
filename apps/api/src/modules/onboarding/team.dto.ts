import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { APP_ROLES } from '../auth/jwt-claims';

// Deliberately declared here rather than imported from KanbanModule's
// kanban.dto.ts, which has a near-identical shape: KanbanModule already
// depends on OnboardingModule, and importing back the other way would make
// the two modules mutually dependent for the sake of one object literal.
export const teamMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  appRole: z.enum(APP_ROLES),
});

export type TeamMemberRecord = z.infer<typeof teamMemberSchema>;

export class TeamMemberDto extends createZodDto(teamMemberSchema) {}
export class TeamMemberListDto extends createZodDto(
  z.array(teamMemberSchema),
) {}

export const changeTeamRoleBodySchema = z.object({
  appRole: z
    .enum(APP_ROLES)
    .describe('Role the member should hold from now on.'),
});

export type ChangeTeamRoleBody = z.infer<typeof changeTeamRoleBodySchema>;
export class ChangeTeamRoleBodyDto extends createZodDto(
  changeTeamRoleBodySchema,
) {}

export const removeTeamMemberResultSchema = z.object({
  releasedTickets: z
    .number()
    .int()
    .describe(
      'Unresolved tickets the removed member held, put back in the OPEN queue by this call.',
    ),
});

export type RemoveTeamMemberResult = z.infer<
  typeof removeTeamMemberResultSchema
>;
export class RemoveTeamMemberResultDto extends createZodDto(
  removeTeamMemberResultSchema,
) {}
