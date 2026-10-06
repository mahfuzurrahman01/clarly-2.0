import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const tenantProvisioningResultSchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  /** True only when a real Supabase Admin API call actually set the user's claims — false under the 'none' provider, where the caller must re-check with a platform admin before the signing-up user's session reflects tenant access. */
  claimsAssigned: z
    .boolean()
    .describe(
      "True when the user's Supabase claims were updated. False under the 'none' provider — the caller must refresh their session out-of-band before tenant-scoped routes will accept their token.",
    ),
});

export type TenantProvisioningResult = z.infer<
  typeof tenantProvisioningResultSchema
>;

export class TenantProvisioningResultDto extends createZodDto(
  tenantProvisioningResultSchema,
) {}
