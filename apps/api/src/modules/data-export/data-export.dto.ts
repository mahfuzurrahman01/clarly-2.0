import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import { DATA_EXPORT_STATUSES } from '../persistence/drizzle/schema';

export const dataExportSchema = z.object({
  id: z.string().uuid(),
  status: z
    .enum(DATA_EXPORT_STATUSES)
    .describe(
      '`pending` queued, `running` being assembled, `ready` downloadable, `failed` see `error`.',
    ),
  requestedBy: z.string().describe('Auth user id of the admin who asked.'),
  rowCounts: z
    .record(z.number().int())
    .nullable()
    .describe(
      'Rows contributed per table. Lets you confirm the export is complete without parsing the bundle.',
    ),
  sizeBytes: z.number().int().nullable(),
  error: z
    .string()
    .nullable()
    .describe('Why it failed. Null unless `status` is `failed`.'),
  expiresAt: isoTimestamp()
    .nullable()
    .describe(
      'When the bundle is deleted from storage. A full copy of a workspace is the most sensitive artifact this system produces, so it does not linger.',
    ),
  createdAt: isoTimestamp(),
  completedAt: isoTimestamp().nullable(),
});

export type DataExportRecord = z.infer<typeof dataExportSchema>;

export class DataExportDto extends createZodDto(dataExportSchema) {}
export class DataExportListDto extends createZodDto(
  z.array(dataExportSchema),
) {}
