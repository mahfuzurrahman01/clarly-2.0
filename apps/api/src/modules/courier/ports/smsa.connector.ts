// F26 (Delivery Tracking): SMSA Express adapter.
//
// Auth model (D1): a single static API key in an `apikey` request header.
// This is SMSA's eCom REST API — the older SOAP surface uses a `passkey`
// instead, and D1 decides we integrate the REST one. No OAuth, no refresh.
//
// Push callbacks: none documented. Poll only, so `webhookSignatureHeader` is
// null and the webhook route rejects `/couriers/webhook/smsa/...` at step 1.
//
// STATUS OF THIS CODE: documentation-accurate, never executed against a live
// SMSA account (F26 "Open items" #1). The response parser is deliberately
// tolerant about field NAMES (`scans` vs `Scans`, `Date` vs `dateTime`)
// because SMSA's published samples differ between their eCom and legacy docs
// — but it is not tolerant about meaning: an event it cannot read a status
// from is dropped, never guessed at.
import { Injectable } from '@nestjs/common';
import {
  CourierConnector,
  CourierTransportError,
  type CourierStatusEvent,
  type CourierTrackingResult,
  type ShipmentStatus,
} from './courier-connector.port';
import {
  asArray,
  asRecord,
  courierFetchJson,
  parseCourierDate,
  pickOptionalDate,
  pickString,
  requireCredential,
} from './courier-http';
import { statusFromKeywords } from './status-keywords';

const TRACKING_BASE_URL =
  'https://ecomapis.smsaexpress.com/api/shipment/b2c/track';

/**
 * SMSA activity codes -> platform status. Pinned from SMSA's published
 * tracking-activity list; anything not here falls through to the shared
 * keyword pass and then to `unknown`.
 */
const SMSA_ACTIVITY_CODES: Readonly<Record<string, ShipmentStatus>> = {
  BCD: 'label_created',
  PUD: 'picked_up',
  DEP: 'in_transit',
  ARR: 'in_transit',
  OFD: 'out_for_delivery',
  DLV: 'delivered',
  UND: 'failed_attempt',
  RTS: 'returned',
  CAN: 'cancelled',
  HLD: 'exception',
};

@Injectable()
export class SmsaConnector extends CourierConnector {
  readonly courier = 'smsa' as const;

  /** Poll only — see the header. */
  readonly webhookSignatureHeader = null;

  async verifyCredentials(credentials: Record<string, string>): Promise<void> {
    // SMSA answers an unknown AWB with a 200 and an empty scan list, and a
    // bad key with a 401 — which `courierFetchJson` turns into a
    // `CourierAuthenticationError`. So a probe track IS the credential check,
    // and a transport-level failure on the probe must not reject a key that
    // is actually fine.
    try {
      await this.trackOne(credentials, '0000000000');
    } catch (error) {
      if (error instanceof CourierTransportError) return;
      throw error;
    }
  }

  /**
   * SMSA's track endpoint is by single AWB, so this is one call per tracking
   * number. They are issued sequentially rather than in parallel: a sweep
   * batch for one merchant is small, and a burst of parallel calls is how a
   * shared API key gets rate-limited for every shipment at once.
   */
  async track(
    credentials: Record<string, string>,
    trackingNumbers: string[],
  ): Promise<CourierTrackingResult[]> {
    const results: CourierTrackingResult[] = [];
    for (const trackingNumber of trackingNumbers) {
      results.push(await this.trackOne(credentials, trackingNumber));
    }
    return results;
  }

  verifyWebhookSignature(): boolean {
    return false;
  }

  extractEventId(): string | null {
    return null;
  }

  normalizeWebhookEvent(): null {
    return null;
  }

  private async trackOne(
    credentials: Record<string, string>,
    trackingNumber: string,
  ): Promise<CourierTrackingResult> {
    const apiKey = requireCredential(this.courier, credentials, 'apiKey');
    const body = await courierFetchJson<unknown>(this.courier, {
      url: `${TRACKING_BASE_URL}/${encodeURIComponent(trackingNumber)}`,
      headers: { apikey: apiKey },
    });

    const root = asRecord(Array.isArray(body) ? body[0] : body);
    const scans = asArray(root.scans ?? root.Scans ?? root.trackingDetails);

    const events = scans
      .map((raw) => this.toEvent(asRecord(raw)))
      .filter((event): event is CourierStatusEvent => event !== null)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

    return {
      trackingNumber,
      currentStatus: events.at(-1)?.status ?? 'unknown',
      events,
      // Not in SMSA's published eCom schema — `expectedDeliveryDate` is the
      // camelCase shape their eCom responses use elsewhere (same tolerant,
      // unconfirmed-name footing this file already takes with `scans`
      // above; MUST be confirmed against a sandbox account, F26 "Open
      // items" #1). Usually absent, in which case this stays undefined.
      estimatedDeliveryAt: pickOptionalDate(
        root,
        'expectedDeliveryDate',
        'estimatedDeliveryDate',
        'eta',
      ),
    };
  }

  private toEvent(raw: Record<string, unknown>): CourierStatusEvent | null {
    const code = pickString(raw, 'activityCode', 'ActivityCode', 'code');
    const description = pickString(
      raw,
      'activity',
      'Activity',
      'description',
      'Description',
    );
    const rawStatus = code ?? description;
    if (!rawStatus) return null;

    const status =
      (code ? SMSA_ACTIVITY_CODES[code.toUpperCase()] : undefined) ??
      statusFromKeywords(description) ??
      'unknown';

    return {
      status,
      rawStatus,
      occurredAt: parseCourierDate(
        raw.dateTime ?? raw.DateTime ?? raw.date ?? raw.Date,
      ),
      location: pickString(raw, 'location', 'Location', 'city', 'City'),
    };
  }
}
