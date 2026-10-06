// F26 (Delivery Tracking): Naqel Express adapter.
//
// Auth model (D1): account credentials — `ClientID` + `Password` in a client
// info block, the same shape as Aramex. No OAuth.
//
// Push callbacks: none documented. Poll only.
//
// STATUS OF THIS CODE: documentation-accurate, never executed against a live
// Naqel account (F26 "Open items" #1).
import { Injectable } from '@nestjs/common';
import {
  CourierAuthenticationError,
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

const TRACKING_URL = 'https://api.naqelexpress.com/Waybill/Track';

/**
 * Naqel activity codes -> platform status. Pinned from Naqel's published
 * waybill-status list; anything not here falls through to the shared keyword
 * pass and then to `unknown`.
 */
const NAQEL_ACTIVITY_CODES: Readonly<Record<string, ShipmentStatus>> = {
  '1': 'label_created',
  '2': 'picked_up',
  '3': 'in_transit',
  '4': 'in_transit',
  '5': 'out_for_delivery',
  '6': 'delivered',
  '7': 'failed_attempt',
  '8': 'returned',
  '9': 'cancelled',
};

interface NaqelTrackingResponse {
  HasError?: boolean;
  Message?: string;
  Waybills?: unknown;
  TrackingDetails?: unknown;
}

@Injectable()
export class NaqelConnector extends CourierConnector {
  readonly courier = 'naqel' as const;

  /** Poll only — see the header. */
  readonly webhookSignatureHeader = null;

  async verifyCredentials(credentials: Record<string, string>): Promise<void> {
    try {
      await this.request(credentials, ['0000000000']);
    } catch (error) {
      if (error instanceof CourierTransportError) return;
      throw error;
    }
  }

  async track(
    credentials: Record<string, string>,
    trackingNumbers: string[],
  ): Promise<CourierTrackingResult[]> {
    if (trackingNumbers.length === 0) return [];
    const body = await this.request(credentials, trackingNumbers);

    // Naqel answers either with a per-waybill envelope or, for a single
    // waybill, with the detail list at the top level. Both are read here
    // rather than assuming one, because which one you get depends on the
    // account's API version.
    const envelopes = asArray(body.Waybills);
    if (envelopes.length > 0) {
      return envelopes.flatMap((entry) => {
        const envelope = asRecord(entry);
        const trackingNumber = pickString(
          envelope,
          'WaybillNo',
          'WaybillNumber',
          'waybill',
        );
        if (!trackingNumber) return [];
        return [
          this.toResult(
            trackingNumber,
            asArray(envelope.TrackingDetails ?? envelope.Details),
            envelope,
          ),
        ];
      });
    }

    if (trackingNumbers.length === 1) {
      return [
        this.toResult(
          trackingNumbers[0],
          asArray(body.TrackingDetails),
          asRecord(body),
        ),
      ];
    }
    return [];
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

  private toResult(
    trackingNumber: string,
    details: unknown[],
    envelope: Record<string, unknown>,
  ): CourierTrackingResult {
    const events = details
      .map((raw) => this.toEvent(asRecord(raw)))
      .filter((event): event is CourierStatusEvent => event !== null)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

    return {
      trackingNumber,
      currentStatus: events.at(-1)?.status ?? 'unknown',
      events,
      // Not in Naqel's published waybill-tracking schema —
      // `ExpectedDeliveryDate` follows the same PascalCase shape as this
      // envelope's other fields, but is an unconfirmed guess like
      // `NAQEL_ACTIVITY_CODES` above (MUST be confirmed against a sandbox
      // account, F26 "Open items" #1). Usually absent, in which case this
      // stays undefined.
      estimatedDeliveryAt: pickOptionalDate(
        envelope,
        'ExpectedDeliveryDate',
        'EstimatedDeliveryDate',
      ),
    };
  }

  private toEvent(raw: Record<string, unknown>): CourierStatusEvent | null {
    const code = pickString(raw, 'ActivityCode', 'StatusCode');
    const description = pickString(raw, 'ActivityName', 'Status', 'Activity');
    const rawStatus = code ?? description;
    if (!rawStatus) return null;

    const status =
      (code ? NAQEL_ACTIVITY_CODES[code] : undefined) ??
      statusFromKeywords(description) ??
      'unknown';

    return {
      status,
      rawStatus,
      occurredAt: parseCourierDate(raw.ActivityDate ?? raw.StatusDate),
      location: pickString(raw, 'CityName', 'City', 'Location'),
    };
  }

  private async request(
    credentials: Record<string, string>,
    waybills: string[],
  ): Promise<NaqelTrackingResponse> {
    const body = await courierFetchJson<NaqelTrackingResponse>(this.courier, {
      url: TRACKING_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ClientInfo: {
          ClientID: requireCredential(this.courier, credentials, 'clientId'),
          Password: requireCredential(this.courier, credentials, 'password'),
        },
        WaybillNo: waybills,
      }),
    });

    // Like Aramex, Naqel reports a rejected credential inside a 200.
    if (body.HasError) {
      const detail = body.Message ?? 'no detail supplied';
      if (/authent|unauthor|invalid client|invalid password/i.test(detail)) {
        throw new CourierAuthenticationError(this.courier, detail);
      }
      throw new CourierTransportError(this.courier, detail);
    }
    return body;
  }
}
