import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const signupBodySchema = z.object({
  tenantName: z
    .string()
    .min(1)
    .max(200)
    .describe('Display name for the tenant being provisioned.'),
});

export type SignupBody = z.infer<typeof signupBodySchema>;

export class SignupBodyDto extends createZodDto(signupBodySchema) {}
