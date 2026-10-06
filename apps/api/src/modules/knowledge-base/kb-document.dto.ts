import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { KB_DOCUMENT_STATUSES } from '../persistence/drizzle/schema';

export const kbDocumentRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  filename: z.string(),
  storageKey: z
    .string()
    .describe(
      'Opaque ObjectStorage key — resolved back to bytes only via the port.',
    ),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  status: z
    .enum(KB_DOCUMENT_STATUSES)
    .describe(
      'Uploads land as `uploaded`, move to `ingest_queued`, then `ingested` or `failed` once the kb-ingest worker runs.',
    ),
});

export type KbDocumentRecord = z.infer<typeof kbDocumentRecordSchema>;

export class KbDocumentRecordDto extends createZodDto(kbDocumentRecordSchema) {}
export class KbDocumentListDto extends createZodDto(
  z.array(kbDocumentRecordSchema),
) {}
