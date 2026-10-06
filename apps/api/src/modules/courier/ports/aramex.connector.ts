// F26 (Delivery Tracking): Aramex adapter.
//
// Auth model (D1): account credentials — username + password plus
// AccountNumber / AccountPin / AccountEntity / AccountCountryCode — sent in a
// `ClientInfo` block on every call. This is the JSON-over-REST façade of
// Aramex's SOAP Shipping/Tracking services, not OAuth; there is no token to
// refresh and no redirect to forge.
//
// Push callbacks: Aramex's enterprise "tracking push" is account-provisioned
// with no documented signature scheme, so D1 decides we do NOT accept it.
// `webhookSignatureHeader` is null, which makes the webhook route reject
// `/couriers/webhook/aramex/...` at step 1 before anything else runs. Poll
// only.
//
// STATUS OF THIS CODE: documentation-accurate, never executed against a live
// Aramex account. The endpoint path, the ClientInfo field names and the
// update-code table below are pinned from Aramex's published Tracking API
// documentation and MUST be confirmed against a sandbox account before go-live
// (F26 "Open items" #1). The keyword fallback in `status-keywords.ts` is what
// keeps an unconfirmed code from becoming a wrong answer rather than an
// `unknown`.
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

const TRACKING_URL =
  'https://ws.aramex.net/ShippingAPI.V2/Tracking/Service_1_0.svc/json/TrackShipments';

/** `Source: 24` is the constant Aramex's own samples send for the REST/JSON façade. */
const ARAMEX_SOURCE = 24;
const ARAMEX_VERSION = 'v1.0';

/**
 * Aramex shipment update codes -> platform status. Pinned from Aramex's
 * published update-code list; a code that is not here falls through to the
 * shared keyword pass and then to `unknown`.
 */
const ARAMEX_UPDATE_CODES: Readonly<Record<string, ShipmentStatus>> = {
  SH001: 'label_created',
  SH002: 'picked_up',
  SH003: 'in_transit',
  SH004: 'in_transit',
  SH005: 'out_for_delivery',
  SH006: 'failed_attempt',
  SH014: 'delivered',
  SH029: 'returned',
  SH043: 'cancelled',
};

interface AramexTrackingResponse {
  HasErrors?: boolean;
  Notifications?: Array<{ Code?: string; Message?: string }>;
  TrackingResults?: Array<{ Key?: string; Value?: unknown }>;
}

@Injectable()
export class AramexConnector extends CourierConnector {
  readonly courier = 'aramex' as const;

  /** Poll only — see the header. */
  readonly webhookSignatureHeader = null;

  async verifyCredentials(credentials: Record<string, string>): Promise<void> {
    // A track of an AWB that cannot exist: we only need to learn
    // "authenticated" vs "rejected". Nothing is created and nothing is billed.
    //
    // A transport error is swallowed on purpose — Aramex also answers "no
    // such waybill" with HasErrors, and refusing to save a connection because
    // the deliberately-invalid probe AWB was not found would reject correct
    // credentials. Only `CourierAuthenticationError` means "rejected", and
    // `request()` below is what decides that.
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
    // Aramex's TrackShipments takes an array, so a whole connection's sweep
    // is one call rather than one per AWB.
    const body = await this.request(credentials, trackingNumbers);

    return asArray(body.TrackingResults).flatMap((entry) => {
      const result = asRecord(entry);
      const trackingNumber = pickString(result, 'Key');
      if (!trackingNumber) return [];

      const events = asArray(result.Value)
        .map((raw) => this.toEvent(asRecord(raw)))
        .filter((event): event is CourierStatusEvent => event !== null)
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

      return [
        {
          trackingNumber,
          currentStatus: events.at(-1)?.status ?? 'unknown',
          events,
          // Aramex's published TrackShipments schema does not document an
          // ETA field on the TrackingResult envelope itself — `ExpectedDeliveryDate`
          // here is the field name some Aramex accounts' responses have been
          // observed to carry, NOT a confirmed part of the published contract
          // (same "pin now, confirm against a sandbox before go-live"
          // footing as `ARAMEX_UPDATE_CODES` above). Absent, as it usually
          // will be, this is simply undefined and nothing is written.
          estimatedDeliveryAt: pickOptionalDate(
            result,
            'ExpectedDeliveryDate',
            'EstimatedDeliveryDate',
          ),
        },
      ];
    });
  }

  verifyWebhookSignature(): boolean {
    // Fail closed. Aramex's push has no signature scheme we can verify, so
    // there is no "valid" to return — and the route rejects this courier
    // before it reaches here anyway.
    return false;
  }

  extractEventId(): string | null {
    return null;
  }

  normalizeWebhookEvent(): null {
    return null;
  }

  private toEvent(raw: Record<string, unknown>): CourierStatusEvent | null {
    const rawStatus =
      pickString(raw, 'UpdateCode') ??
      pickString(raw, 'UpdateDescription') ??
      null;
    if (!rawStatus) return null;

    const description = pickString(raw, 'UpdateDescription');
    const status =
      ARAMEX_UPDATE_CODES[rawStatus] ??
      statusFromKeywords(description) ??
      'unknown';

    return {
      status,
      rawStatus,
      occurredAt: parseCourierDate(raw.UpdateDateTime),
      // `Comments` and `ProblemCode` are deliberately NOT carried: they are
      // free prose written by whoever scanned the parcel, and D4 keeps
      // courier prose out of everything the model can see.
      location: pickString(raw, 'UpdateLocation'),
    };
  }

  private async request(
    credentials: Record<string, string>,
    shipments: string[],
  ): Promise<AramexTrackingResponse> {
    const clientInfo = {
      UserName: requireCredential(this.courier, credentials, 'username'),
      Password: requireCredential(this.courier, credentials, 'password'),
      AccountNumber: requireCredential(
        this.courier,
        credentials,
        'accountNumber',
      ),
      AccountPin: requireCredential(this.courier, credentials, 'accountPin'),
      AccountEntity: requireCredential(
        this.courier,
        credentials,
        'accountEntity',
      ),
      AccountCountryCode: requireCredential(
        this.courier,
        credentials,
        'accountCountryCode',
      ),
      Version: ARAMEX_VERSION,
      Source: ARAMEX_SOURCE,
    };

    const body = await courierFetchJson<AramexTrackingResponse>(this.courier, {
      url: TRACKING_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ClientInfo: clientInfo,
        Shipments: shipments,
        GetLastTrackingUpdateOnly: false,
        Transaction: { Reference1: 'clarly-f26' },
      }),
    });

    // Aramex answers a rejected credential with HTTP 200 and HasErrors, not a
    // 401 — so the transport helper's status check is not enough on its own,
    // and the two failure classes have to be separated here instead.
    if (body.HasErrors) {
      const detail =
        body.Notifications?.map((n) => n.Message ?? n.Code ?? '')
          .filter(Boolean)
          .join('; ') || 'no detail supplied';
      if (isAramexAuthFailure(detail)) {
        throw new CourierAuthenticationError(this.courier, detail);
      }
      throw new CourierTransportError(this.courier, detail);
    }
    return body;
  }
}

/**
 * Aramex reports a credential rejection as a notification inside a 200, so
 * the only way to tell "your password is wrong" from "that waybill does not
 * exist" is the notification text. Exported for the contract tests, which
 * pin the phrases against recorded fixtures.
 */
export function isAramexAuthFailure(detail: string): boolean {
  const haystack = detail.toLowerCase();
  return (
    haystack.includes('authent') ||
    haystack.includes('unauthor') ||
    haystack.includes('invalid clientinfo') ||
    haystack.includes('invalid account') ||
    haystack.includes('account number') ||
    haystack.includes('invalid username') ||
    haystack.includes('invalid password')
  );
}
