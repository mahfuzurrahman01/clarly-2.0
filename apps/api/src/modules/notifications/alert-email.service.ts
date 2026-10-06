// NotificationsModule (gap #3): the second delivery channel for an alert.
//
// A notification row is only seen by someone who has the console open. The
// alert that most needs a channel is the one that fires when nobody does: a
// ticket escalated to a human and left unclaimed. This service takes the
// alerts that mean "a customer is waiting on a person" and mails the
// tenant's admins.
//
// Only `critical` severity is mailed. The warning-level alerts (latency
// drift, blocked tool calls) are real, but they are things to look at, not
// things to be woken up for — mailing them is how a tenant learns to filter
// this sender.
import { Injectable } from '@nestjs/common';
import { AppConfigService, AppLoggerService } from '../core';
import { EmailSender } from '../email/ports/email-sender.port';
import { TenantAuthProvisioningPort } from '../onboarding/ports/tenant-auth-provisioning.port';

export interface AlertEmailInput {
  tenantId: string;
  title: string;
  body: string;
  entityType?: string | null;
  entityId?: string | null;
}

@Injectable()
export class AlertEmailService {
  constructor(
    private readonly email: EmailSender,
    private readonly provisioning: TenantAuthProvisioningPort,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Returns whether a message was actually handed to the provider, so the
   * caller can log the difference between "mailed" and "recorded only".
   * Never throws: this runs off an alert sweep, and a mail failure must not
   * cost the tenant the notification row that already landed.
   */
  async sendCriticalAlert(input: AlertEmailInput): Promise<boolean> {
    if (!this.email.isEnabled()) {
      // Debug, not warn: an unconfigured environment is the default and
      // saying so at warning level on every alert would train people to
      // ignore the log. NoopEmailSender warns once at the send itself.
      this.logger.debug(
        `no mail provider configured — "${input.title}" for tenant ${input.tenantId} was recorded but not emailed`,
        'AlertEmailService',
      );
      return false;
    }

    try {
      const recipients = await this.adminEmails(input.tenantId);
      if (recipients.length === 0) {
        this.logger.warn(
          `tenant ${input.tenantId} has no admin with an email address — "${input.title}" was recorded but could not be emailed`,
          'AlertEmailService',
        );
        return false;
      }

      const link = this.consoleLink(input.entityType);
      const result = await this.email.send({
        to: recipients,
        subject: input.title,
        text: plainText(input.body, link),
        html: htmlBody(input.title, input.body, link),
      });

      this.logger.log(
        `emailed "${input.title}" to ${recipients.length} admin(s) of tenant ${input.tenantId}` +
          `${result.providerMessageId === null ? '' : ` (provider id ${result.providerMessageId})`}`,
        'AlertEmailService',
      );
      return true;
    } catch (error) {
      this.logger.error(
        `failed to email "${input.title}" to tenant ${input.tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'AlertEmailService',
      );
      return false;
    }
  }

  /**
   * Admins only. An agent seeing an unclaimed ticket in the console is the
   * intended path; mailing every agent on every escalation turns the alert
   * into noise and makes it likelier that the one person who must act
   * ignores it.
   */
  private async adminEmails(tenantId: string): Promise<string[]> {
    const members = await this.provisioning.listTeamMembers(tenantId);
    return members
      .filter((member) => member.appRole === 'admin' && member.email !== '')
      .map((member) => member.email);
  }

  /** Null when CONSOLE_BASE_URL is unset — the mail then says what happened without offering a link that would 404. */
  private consoleLink(entityType?: string | null): string | null {
    const base = this.config.consoleBaseUrl.replace(/\/+$/, '');
    if (base === '') {
      return null;
    }
    return entityType === 'ticket' ? `${base}/tickets` : `${base}/home`;
  }
}

function plainText(body: string, link: string | null): string {
  return link === null ? `${body}\n` : `${body}\n\nOpen the console: ${link}\n`;
}

/**
 * Hand-written, deliberately plain HTML. Every value interpolated here is
 * composed by this app from alert fields (counts, thresholds, minutes), not
 * by a customer — but it is escaped anyway, because the day someone puts a
 * tenant-supplied name in an alert title is the day an unescaped template
 * becomes an injection into somebody's inbox.
 */
function htmlBody(title: string, body: string, link: string | null): string {
  const linkHtml =
    link === null
      ? ''
      : `<p style="margin:24px 0 0"><a href="${escapeHtml(link)}">Open the console</a></p>`;
  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#111">',
    `<h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(title)}</h1>`,
    `<p style="margin:0">${escapeHtml(body)}</p>`,
    linkHtml,
    '</div>',
  ].join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
