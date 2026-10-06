// Product shell (TemplatesModule, F12): the tenant's own library of reusable
// message bodies.
//
// Owns `message_templates` and nothing else. The send path lives in
// InboxModule with the rest of human replying — this module answers "what may
// I send", not "send it", the same split KanbanModule/TicketModule use.
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import {
  messageTemplates,
  type TemplateApprovalStatus,
  type TemplateCategory,
  type TemplateKind,
  type TemplateVariable,
} from '../persistence/drizzle/schema';
import { isUniqueViolation } from '../persistence/postgres-error';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import {
  assertWellFormedTemplateBody,
  templatePositions,
} from './template-body';

export interface MessageTemplateRecord {
  id: string;
  kind: TemplateKind;
  name: string;
  language: string;
  category: TemplateCategory | null;
  body: string;
  variables: TemplateVariable[];
  approvalStatus: TemplateApprovalStatus;
  approvalDetail: string | null;
  /**
   * F19 (D2): the WABA this template is approved on, or null when it has
   * never been established (or two WABAs claim the same name). Null blocks a
   * campaign send — see the column comment in message-templates.table.ts.
   */
  wabaId: string | null;
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTemplateInput {
  kind: TemplateKind;
  name: string;
  language: string;
  category: TemplateCategory | null;
  body: string;
  variables: TemplateVariable[];
}

export type UpdateTemplateInput = Partial<
  Pick<CreateTemplateInput, 'name' | 'category' | 'body' | 'variables'>
>;

@Injectable()
export class MessageTemplateService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async list(
    tenantId: string,
    filter: { kind?: TemplateKind } = {},
  ): Promise<MessageTemplateRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(messageTemplates)
          .where(
            filter.kind
              ? and(
                  eq(messageTemplates.tenantId, tenantId),
                  eq(messageTemplates.kind, filter.kind),
                )
              : eq(messageTemplates.tenantId, tenantId),
          )
          .orderBy(asc(messageTemplates.name), asc(messageTemplates.language)),
      tenantId,
    );
    return rows.map(toRecord);
  }

  async get(
    tenantId: string,
    id: string,
  ): Promise<MessageTemplateRecord | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(messageTemplates)
          .where(
            and(
              eq(messageTemplates.id, id),
              eq(messageTemplates.tenantId, tenantId),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Same as `get`, but a missing row is the caller's error rather than a null they have to remember to check. */
  async require(tenantId: string, id: string): Promise<MessageTemplateRecord> {
    const template = await this.get(tenantId, id);
    if (!template) {
      throw new NotFoundException(`Template ${id} not found`);
    }
    return template;
  }

  async create(
    tenantId: string,
    input: CreateTemplateInput,
  ): Promise<MessageTemplateRecord> {
    assertWellFormedTemplateBody(input.body);
    const variables = alignVariables(input.body, input.variables);

    try {
      const [row] = await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .insert(messageTemplates)
            .values({
              tenantId,
              kind: input.kind,
              name: input.name,
              language: input.language,
              category: input.category,
              body: input.body,
              variables,
              // A canned reply never goes through review, so `local` is the
              // truth. A WhatsApp template is `pending` until a sync hears
              // otherwise from the BSP — see the table comment on why we do
              // not take the tenant's word for approval.
              approvalStatus:
                input.kind === 'canned_reply' ? 'local' : 'pending',
            })
            .returning(),
        tenantId,
      );
      return toRecord(row);
    } catch (error) {
      throw asConflictIfDuplicate(error, input);
    }
  }

  /**
   * Editing an approved WhatsApp template's body puts it back to `pending`:
   * Meta approved specific words, and sending different ones under an
   * approved name is what gets a WABA flagged. The name and language are the
   * identity Meta knows it by and are not editable — a tenant who wants a
   * different name is creating a different template.
   */
  async update(
    tenantId: string,
    id: string,
    input: UpdateTemplateInput,
  ): Promise<MessageTemplateRecord> {
    const existing = await this.require(tenantId, id);

    const body = input.body ?? existing.body;
    if (input.body !== undefined) {
      assertWellFormedTemplateBody(body);
    }
    const variables = alignVariables(
      body,
      input.variables ?? existing.variables,
    );

    const bodyChanged =
      input.body !== undefined && input.body !== existing.body;
    const resetsApproval = bodyChanged && existing.kind === 'whatsapp_template';

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(messageTemplates)
          .set({
            body,
            variables,
            category: input.category ?? existing.category,
            updatedAt: new Date(),
            ...(resetsApproval
              ? {
                  approvalStatus: 'pending' as const,
                  approvalDetail: null,
                  syncedAt: null,
                }
              : {}),
          })
          .where(
            and(
              eq(messageTemplates.id, id),
              eq(messageTemplates.tenantId, tenantId),
            ),
          )
          .returning(),
      tenantId,
    );
    return toRecord(row);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .delete(messageTemplates)
          .where(
            and(
              eq(messageTemplates.id, id),
              eq(messageTemplates.tenantId, tenantId),
            ),
          )
          .returning({ id: messageTemplates.id }),
      tenantId,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`Template ${id} not found`);
    }
  }

  /**
   * Reconciles what the BSP says about a WhatsApp template against what we
   * stored. Called by the sync path; separate from `update` because this is
   * the one writer allowed to set `approved`.
   */
  async recordApproval(
    tenantId: string,
    id: string,
    status: TemplateApprovalStatus,
    detail: string | null,
    at: Date,
    /**
     * F19 (D2): the WABA whose listing reported this template. `undefined`
     * leaves the stored value alone (a caller that does not know); `null`
     * clears it, which is what an ambiguous report must do — a stale WABA is
     * worse than no WABA, because only the latter blocks the send.
     */
    wabaId?: string | null,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(messageTemplates)
          .set({
            approvalStatus: status,
            approvalDetail: detail,
            ...(wabaId === undefined ? {} : { wabaId }),
            syncedAt: at,
            updatedAt: at,
          })
          .where(
            and(
              eq(messageTemplates.id, id),
              eq(messageTemplates.tenantId, tenantId),
            ),
          ),
      tenantId,
    );
  }
}

/**
 * Makes the stored variable list match the body's actual placeholders.
 *
 * A tenant who deletes `{{2}}` from a body and forgets to delete its label
 * would otherwise leave the console prompting for a value that goes nowhere.
 * Labels the tenant did supply are preserved by position; the rest get a
 * generic one rather than being refused, because a missing label is a
 * cosmetic problem and refusing the save is not.
 */
function alignVariables(
  body: string,
  supplied: TemplateVariable[],
): TemplateVariable[] {
  const byPosition = new Map(
    supplied.map((variable) => [variable.position, variable]),
  );

  return templatePositions(body).map((position) => {
    const existing = byPosition.get(position);
    return {
      position,
      label: existing?.label ?? `Value ${position}`,
      example: existing?.example ?? null,
    };
  });
}

function asConflictIfDuplicate(
  error: unknown,
  input: CreateTemplateInput,
): unknown {
  if (isUniqueViolation(error)) {
    return new ConflictException(
      `A ${input.kind === 'canned_reply' ? 'canned reply' : 'template'} named "${input.name}" already exists in ${input.language}.`,
    );
  }
  return error;
}

function toRecord(
  row: typeof messageTemplates.$inferSelect,
): MessageTemplateRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    language: row.language,
    category: row.category,
    body: row.body,
    variables: row.variables,
    approvalStatus: row.approvalStatus,
    approvalDetail: row.approvalDetail,
    wabaId: row.wabaId,
    syncedAt: row.syncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
