import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';

export const tenantClosureSchema = z.object({
  tenantId: z.string().uuid(),
  closedAt: isoTimestamp()
    .nullable()
    .describe(
      'When the workspace was closed. Null means it is open. Access stops from this moment, but nothing has been deleted yet.',
    ),
  purgeAfter: isoTimestamp()
    .nullable()
    .describe(
      'When the data is actually erased, permanently. Until this passes the close can still be undone with `POST /onboarding/tenant/reopen`; after it, nothing remains to reopen.',
    ),
});

export type TenantClosureRecord = z.infer<typeof tenantClosureSchema>;

export class TenantClosureDto extends createZodDto(tenantClosureSchema) {}
