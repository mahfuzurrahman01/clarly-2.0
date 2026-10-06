// Product shell (TemplatesModule, F12): reconciling stored approval state
// against what the BSP actually says.
//
// Without this, `approved` is unreachable — every WhatsApp template is stored
// as `pending` and the send path refuses all of them, which would make the
// feature a dead end in a different place than the one it set out to fix.
//
// Deliberately pull, not push: Meta does send template status webhooks, but
// they arrive on the same endpoint as customer messages and a tenant whose
// webhook was misconfigured for an hour would silently hold a wrong status
// forever. A listing that can be re-run on demand recovers from that; a
// missed event does not.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import {
  BspAdapter,
  type BspTemplateStatus,
} from '../whatsapp/ports/bsp-adapter.port';
import { WhatsappNumberDirectory } from '../whatsapp/whatsapp-number-directory.service';
import type { TemplateApprovalStatus } from '../persistence/drizzle/schema';
import { MessageTemplateService } from './message-template.service';

export interface TemplateSyncResult {
  /** Templates whose stored status changed. */
  updated: number;
  /** Stored templates the BSP has never heard of — the tenant registered a name here that does not exist in their WhatsApp Business account. */
  unknownToBsp: string[];
  /** True when no connected number could report at all, so nothing was reconciled and nothing was changed. */
  unreported: boolean;
}

/**
 * Meta's review states, mapped onto ours.
 *
 * Anything unrecognised maps to `pending` rather than `approved`: a status we
 * cannot read must never unlock a send, and a new Meta state appearing is far
 * more likely than a template being genuinely fine under a name we do not
 * know.
 */
function mapStatus(metaStatus: string): TemplateApprovalStatus {
  switch (metaStatus) {
    case 'APPROVED':
      return 'approved';
    case 'REJECTED':
      return 'rejected';
    case 'PAUSED':
      return 'paused';
    case 'DISABLED':
      return 'disabled';
    default:
      return 'pending';
  }
}

const key = (name: string, language: string) =>
  `${name}::${language.toLowerCase()}`;

/**
 * One reported template, plus the WABA whose listing reported it (F19 D2).
 *
 * `wabaId` is null when the reporting number has no WABA recorded yet, and
 * is CLEARED to null when a second WABA reports the same name/language: a
 * tenant whose two accounts both hold `spring_sale` has no single answer to
 * "which WABA is this template approved on", and guessing one would let a
 * campaign send from the number the guess got wrong. Null blocks instead.
 */
interface ReportedTemplate {
  status: BspTemplateStatus;
  wabaId: string | null;
  /** True once two different WABAs have reported this name/language. */
  ambiguous: boolean;
}

@Injectable()
export class TemplateSyncService {
  constructor(
    private readonly templates: MessageTemplateService,
    private readonly numbers: WhatsappNumberDirectory,
    private readonly bspAdapter: BspAdapter,
    private readonly logger: AppLoggerService,
  ) {}

  async sync(tenantId: string): Promise<TemplateSyncResult> {
    const stored = await this.templates.list(tenantId, {
      kind: 'whatsapp_template',
    });

    if (stored.length === 0) {
      return { updated: 0, unknownToBsp: [], unreported: false };
    }

    const reported = await this.collectReported(tenantId);
    if (!reported) {
      // Nothing is written: an adapter that cannot report and an account with
      // no templates must not look the same, or a sync against a
      // misconfigured number would mark every approved template as unknown.
      return { updated: 0, unknownToBsp: [], unreported: true };
    }

    const now = new Date();
    const unknownToBsp: string[] = [];
    let updated = 0;

    for (const template of stored) {
      const match = reported.get(key(template.name, template.language));
      if (!match) {
        unknownToBsp.push(`${template.name} (${template.language})`);
        continue;
      }

      const status = mapStatus(match.status.status);
      const detail = match.status.reason;
      // F19 (D2): an ambiguous report stores null, which blocks the send —
      // never a guess at which of two accounts approved it.
      const wabaId = match.ambiguous ? null : match.wabaId;
      if (
        status === template.approvalStatus &&
        detail === template.approvalDetail &&
        wabaId === template.wabaId
      ) {
        continue;
      }

      await this.templates.recordApproval(
        tenantId,
        template.id,
        status,
        detail,
        now,
        wabaId,
      );
      updated += 1;
    }

    return { updated, unknownToBsp, unreported: false };
  }

  /**
   * Merges the listings from every connected number.
   *
   * A tenant with two numbers on two WhatsApp Business accounts genuinely has
   * two template sets, and a template approved on either is sendable — so
   * this unions rather than picking one. Returns null only when NO number
   * could report, which is the case that must not be mistaken for "no
   * templates exist".
   */
  private async collectReported(
    tenantId: string,
  ): Promise<Map<string, ReportedTemplate> | null> {
    const numbers = await this.numbers.listForTenant(tenantId);
    const wabaIds = await this.numbers.wabaIdsByPhoneNumber(tenantId);
    const merged = new Map<string, ReportedTemplate>();
    let anyReported = false;

    for (const number of numbers) {
      let listing: BspTemplateStatus[] | null;
      try {
        listing = await this.bspAdapter.listTemplates(number.phoneNumberId);
      } catch (error) {
        // One unreachable number must not lose the sync for the others.
        this.logger.warn(
          `TemplateSyncService: could not list templates for ${number.phoneNumberId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          TemplateSyncService.name,
        );
        continue;
      }

      if (!listing) continue;

      anyReported = true;
      const wabaId = wabaIds.get(number.phoneNumberId) ?? null;
      for (const entry of listing) {
        const entryKey = key(entry.name, entry.language);
        const seen = merged.get(entryKey);
        merged.set(entryKey, {
          status: entry,
          wabaId,
          ambiguous:
            seen !== undefined && (seen.ambiguous || seen.wabaId !== wabaId),
        });
      }
    }

    return anyReported ? merged : null;
  }
}
