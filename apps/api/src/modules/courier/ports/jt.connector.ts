// F26 (Delivery Tracking): J&T Express adapter — the ONLY courier whose push
// callbacks we accept (D1/D6).
//
// Auth model: `apiAccount` + `privateKey`. Every request carries a `digest`
// header = base64(MD5(body + privateKey)). The same scheme signs J&T's
// merchant-registered callbacks, which is precisely why this is the one push
// surface F26 accepts: we can actually verify it.
//
// STATUS OF THIS CODE: documentation-accurate, never executed against a live
// J&T account and never sent a real J&T callback (F26 "Open items" #1).
//
// A note on MD5: it is J&T's scheme, not ours. We are verifying THEIR
// signature, so the algorithm is theirs to choose; the security property that
// matters here — that an attacker without `privateKey` cannot produce a
// matching digest for a body of their choosing — is a preimage/forgery
// property MD5 still provides in this construction, and the comparison is
// constant-time via `safeSignatureEqual`.
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { safeSignatureEqual } from '../../../common/safe-signature-equal';
import {
  CourierConnector,
  CourierTransportError,
  type CourierStatusEvent,
  type CourierTrackingResult,
  type CourierWebhookHeaders,
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

const TRACE_URL =
  'https://openapi.jtexpress.sa/webopenplatformapi/api/logistics/trace';

/** The header J&T actually signs with. Reading an invented header name is how F24 shipped webhooks that were never verified. */
export const JT_DIGEST_HEADER = 'digest';

/**
 * J&T scan types -> platform status. Pinned from J&T's published
 * `scanType` list; anything not here falls through to the shared keyword pass
 * and then to `unknown`.
 */
const JT_SCAN_TYPES: Readonly<Record<string, ShipmentStatus>> = {
  收件: 'picked_up',
  发件: 'in_transit',
  到件: 'in_transit',
  派件: 'out_for_delivery',
  签收: 'delivered',
  问题件: 'exception',
  退件: 'returned',
  'pickup scan': 'picked_up',
  'dispatch scan': 'in_transit',
  'arrival scan': 'in_transit',
  'delivery scan': 'out_for_delivery',
  signed: 'delivered',
  'problem scan': 'exception',
  'return scan': 'returned',
};

interface JtTraceResponse {
  code?: string | number;
  msg?: string;
  data?: unknown;
}

@Injectable()
export class JtConnector extends CourierConnector {
  readonly courier = 'jt' as const;

  readonly webhookSignatureHeader = JT_DIGEST_HEADER;

  /** base64(MD5(body + privateKey)) — J&T's scheme, used for both our outbound calls and their inbound callbacks. */
  static digest(body: string, privateKey: string): string {
    return createHash('md5')
      .update(body + privateKey, 'utf8')
      .digest('base64');
  }

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

    return asArray(body.data).flatMap((entry) => {
      const parcel = asRecord(entry);
      const trackingNumber = pickString(parcel, 'billCode', 'billcode');
      if (!trackingNumber) return [];
      return [
        {
          trackingNumber,
          ...this.summarize(asArray(parcel.details ?? parcel.detail)),
          // Not in J&T's published trace schema — `predictDeliveryTime`
          // follows the camelCase shape J&T's other fields use, but is an
          // unconfirmed guess like `JT_SCAN_TYPES` above (MUST be confirmed
          // against a sandbox account, F26 "Open items" #1). Usually
          // absent, in which case this stays undefined.
          estimatedDeliveryAt: pickOptionalDate(
            parcel,
            'predictDeliveryTime',
            'estimateDeliveryTime',
            'expectedDeliveryTime',
          ),
        },
      ];
    });
  }

  verifyWebhookSignature(
    rawBody: Buffer,
    signature: string,
    secret: string,
  ): boolean {
    if (!signature || !secret) return false;
    return safeSignatureEqual(
      signature,
      JtConnector.digest(rawBody.toString('utf8'), secret),
    );
  }

  /**
   * J&T's callback carries no stable event id of its own, so D6's documented
   * fallback applies: SHA-256 of the raw body. That is stable for a replayed
   * body (which is exactly the case the claim row must catch) and different
   * for a genuinely new push.
   */
  extractEventId(payload: unknown): string | null {
    const root = asRecord(payload);
    const explicit = pickString(root, 'eventId', 'bizId', 'msgId');
    if (explicit) return explicit;
    return createHash('sha256')
      .update(JSON.stringify(payload ?? null))
      .digest('hex');
  }

  normalizeWebhookEvent(
    payload: unknown,
    _headers: CourierWebhookHeaders,
  ): { trackingNumber: string; events: CourierStatusEvent[] } | null {
    const root = asRecord(payload);
    // J&T posts either a single parcel object or a `details` array under a
    // `data` envelope. Note what is NOT read: nothing in this body chooses a
    // tenant, a connection or a courier — those come from the routed URL and
    // the verified signature only (D6).
    const parcel = asRecord(
      Array.isArray(root.data) ? root.data[0] : (root.data ?? root),
    );
    const trackingNumber = pickString(parcel, 'billCode', 'billcode');
    if (!trackingNumber) return null;

    const rawDetails = asArray(parcel.details ?? parcel.detail);
    const details = rawDetails.length > 0 ? rawDetails : [parcel];
    const events = details
      .map((raw) => this.toEvent(asRecord(raw)))
      .filter((event): event is CourierStatusEvent => event !== null);

    return events.length > 0 ? { trackingNumber, events } : null;
  }

  private summarize(details: unknown[]): {
    currentStatus: ShipmentStatus;
    events: CourierStatusEvent[];
  } {
    const events = details
      .map((raw) => this.toEvent(asRecord(raw)))
      .filter((event): event is CourierStatusEvent => event !== null)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    return { currentStatus: events.at(-1)?.status ?? 'unknown', events };
  }

  private toEvent(raw: Record<string, unknown>): CourierStatusEvent | null {
    const scanType = pickString(raw, 'scanType', 'scanTypeName');
    const description = pickString(raw, 'desc', 'scanTypeName', 'problemName');
    const rawStatus = scanType ?? description;
    if (!rawStatus) return null;

    const status =
      (scanType ? JT_SCAN_TYPES[scanType.toLowerCase()] : undefined) ??
      (scanType ? JT_SCAN_TYPES[scanType] : undefined) ??
      statusFromKeywords(description) ??
      'unknown';

    return {
      status,
      rawStatus,
      occurredAt: parseCourierDate(raw.scanTime ?? raw.acceptTime),
      location: pickString(raw, 'scanNetworkCity', 'scanNetworkName', 'city'),
    };
  }

  private async request(
    credentials: Record<string, string>,
    billCodes: string[],
  ): Promise<JtTraceResponse> {
    const apiAccount = requireCredential(
      this.courier,
      credentials,
      'apiAccount',
    );
    const privateKey = requireCredential(
      this.courier,
      credentials,
      'privateKey',
    );
    const body = JSON.stringify({ billCodes });

    const response = await courierFetchJson<JtTraceResponse>(this.courier, {
      url: TRACE_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apiAccount,
        digest: JtConnector.digest(body, privateKey),
        timestamp: String(Date.now()),
      },
      body,
    });

    // J&T reports failures in a 200 body with a non-"1" code.
    const code = response.code === undefined ? '1' : String(response.code);
    if (code !== '1' && code.toLowerCase() !== 'success') {
      throw new CourierTransportError(
        this.courier,
        response.msg ?? `code ${code}`,
      );
    }
    return response;
  }
}
