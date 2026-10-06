// F19 (D1, D8): segment CRUD. Owns `segments` only — resolution/snapshot is
// `SegmentResolverService`, compilation is `segment-compiler.ts`.
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { campaigns, segments } from '../persistence/drizzle/schema';
import { isUniqueViolation } from '../persistence/postgres-error';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import {
  parseSegmentDefinition,
  type SegmentNode,
} from './segment-definition.schema';

export interface SegmentRecord {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  definition: SegmentNode;
  lastResolvedCount: number | null;
  lastResolvedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSegmentInput {
  name: string;
  description?: string | null;
  definition: unknown;
  createdBy?: string | null;
}

export type UpdateSegmentInput = Partial<
  Pick<CreateSegmentInput, 'name' | 'description' | 'definition'>
>;

@Injectable()
export class SegmentService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async create(
    tenantId: string,
    input: CreateSegmentInput,
  ): Promise<SegmentRecord> {
    // Validated on every write (D1) — a definition that fails Zod or the
    // depth/leaf walker never reaches the database.
    const definition = parseSegmentDefinition(input.definition);

    try {
      const [row] = await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .insert(segments)
            .values({
              tenantId,
              name: input.name,
              description: input.description ?? null,
              definition,
              createdBy: input.createdBy ?? null,
            })
            .returning(),
        tenantId,
      );
      return toRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `A segment named "${input.name}" already exists.`,
        );
      }
      throw error;
    }
  }

  async list(tenantId: string): Promise<SegmentRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) => tx.select().from(segments).where(eq(segments.tenantId, tenantId)),
      tenantId,
    );
    return rows.map(toRecord);
  }

  async get(tenantId: string, id: string): Promise<SegmentRecord | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(segments)
          .where(and(eq(segments.id, id), eq(segments.tenantId, tenantId)))
          .limit(1),
      tenantId,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Same as `get`, but re-validates the stored definition (D1: "validated again on every read before compilation") — a row hand-edited in the DB must not reach the compiler unvalidated. */
  async require(tenantId: string, id: string): Promise<SegmentRecord> {
    const segment = await this.get(tenantId, id);
    if (!segment) {
      throw new NotFoundException(`Segment ${id} not found`);
    }
    // Re-parse defensively; a hand-edited row must fail loudly here, not
    // silently at the SQL compiler.
    segment.definition = parseSegmentDefinition(segment.definition);
    return segment;
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateSegmentInput,
  ): Promise<SegmentRecord> {
    await this.require(tenantId, id);
    const definition =
      input.definition !== undefined
        ? parseSegmentDefinition(input.definition)
        : undefined;

    try {
      const [row] = await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .update(segments)
            .set({
              ...(input.name !== undefined && { name: input.name }),
              ...(input.description !== undefined && {
                description: input.description,
              }),
              ...(definition !== undefined && { definition }),
              updatedAt: new Date(),
            })
            .where(and(eq(segments.id, id), eq(segments.tenantId, tenantId)))
            .returning(),
        tenantId,
      );
      return toRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `A segment named "${input.name}" already exists.`,
        );
      }
      throw error;
    }
  }

  /**
   * 409 if referenced by any campaign. `campaigns.(tenant_id, segment_id)`
   * carries `ON DELETE RESTRICT` (D2), so a raw DB constraint violation would
   * already stop this — this check exists to answer with a clear 409 naming
   * the count instead of a raw FK-violation 500, the same reasoning as
   * `CustomerLabelController.requireCustomer()`.
   */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.require(tenantId, id);

    await this.tenantContext.withTenantTx(async (tx) => {
      const [{ value: referencingCount }] = await tx
        .select({ value: count() })
        .from(campaigns)
        .where(
          and(eq(campaigns.tenantId, tenantId), eq(campaigns.segmentId, id)),
        );
      if (referencingCount > 0) {
        throw new ConflictException(
          `Segment ${id} is referenced by ${referencingCount} campaign(s) and cannot be deleted.`,
        );
      }
      await tx
        .delete(segments)
        .where(and(eq(segments.id, id), eq(segments.tenantId, tenantId)));
    }, tenantId);
  }

  /** Called by the resolver after a preview/snapshot — advisory cache only, never used to decide who gets a message (D1). */
  async recordLastResolved(
    tenantId: string,
    id: string,
    resolvedCount: number,
    resolvedAt: Date,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(segments)
          .set({ lastResolvedCount: resolvedCount, lastResolvedAt: resolvedAt })
          .where(and(eq(segments.id, id), eq(segments.tenantId, tenantId))),
      tenantId,
    );
  }
}

function toRecord(row: typeof segments.$inferSelect): SegmentRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    definition: row.definition as SegmentNode,
    lastResolvedCount: row.lastResolvedCount,
    lastResolvedAt: row.lastResolvedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
