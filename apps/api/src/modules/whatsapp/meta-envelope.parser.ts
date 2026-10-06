// Channel (WhatsappModule): Meta Cloud API wire formats — the inbound
// webhook envelope (-> the port's BSP-agnostic NormalizedInboundMessage)
// and the outbound send response.
//
// Kept separate from MetaCloudAdapter so the single most
// security-sensitive parser in the system is a pure, independently tested
// function; the adapter owns only the signature header and outbound auth.
//
// Parsed with zod rather than cast, because this is the most untrusted
// input the system accepts. Leniency at the LEAF is deliberate (an unknown
// message type must degrade to 'unsupported', never throw), while the
// envelope's own shape is validated strictly so a malformed body is a
// clean rejection instead of a downstream `undefined`.
import { z } from 'zod';
import type {
  DeliveryStatus,
  InboundMediaDescriptor,
  InboundMessageType,
  NormalizedInboundMessage,
  NormalizedMessageEcho,
  NormalizedStatusUpdate,
} from './ports/bsp-adapter.port';

/**
 * Meta's media object, identical across image/audio/voice/video/document/
 * sticker apart from which of them carry a filename or caption.
 *
 * Every field but `id` is optional, deliberately: a media message whose
 * mime_type Meta omitted must still be fetchable, and this schema gates the
 * strict inbound parse — a stricter shape here would reject a whole webhook
 * carrying real customer messages over one unexpected field.
 */
const mediaSchema = z.object({
  id: z.string(),
  mime_type: z.string().optional(),
  filename: z.string().optional(),
  caption: z.string().optional(),
  sha256: z.string().optional(),
});

const inboundEnvelopeSchema = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z.object({
                metadata: z.object({ phone_number_id: z.string() }).optional(),
                messages: z
                  .array(
                    z.object({
                      from: z.string(),
                      id: z.string(),
                      // Meta sends unix seconds as a string.
                      timestamp: z.string(),
                      type: z.string(),
                      text: z.object({ body: z.string() }).optional(),
                      image: mediaSchema.optional(),
                      audio: mediaSchema.optional(),
                      voice: mediaSchema.optional(),
                      video: mediaSchema.optional(),
                      document: mediaSchema.optional(),
                      sticker: mediaSchema.optional(),
                    }),
                  )
                  .optional(),
                // Every field is optional even though Meta documents them
                // as present: this schema also gates INBOUND parsing, which
                // throws on a mismatch, and a status callback shaped
                // slightly differently than documented must never reject a
                // webhook carrying real customer messages. Entries missing
                // what a status update needs are dropped below instead.
                statuses: z
                  .array(
                    z.object({
                      id: z.string().optional(),
                      status: z.string().optional(),
                      timestamp: z.string().optional(),
                      errors: z
                        .array(
                          z.object({
                            code: z.number().optional(),
                            title: z.string().optional(),
                            message: z.string().optional(),
                          }),
                        )
                        .optional(),
                    }),
                  )
                  .optional(),
              }),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

/**
 * Meta's `type` -> the port's BSP-agnostic classification. Anything absent
 * from this map (stickers, contacts, location, interactive, reactions,
 * button replies, or a type Meta adds next year) becomes 'unsupported',
 * which T3 turns into a human escalation rather than a dropped message.
 */
const MESSAGE_TYPE_MAP: Record<string, InboundMessageType> = {
  text: 'text',
  image: 'image',
  audio: 'voice',
  voice: 'voice',
  document: 'document',
};

/**
 * One webhook POST can carry several entries/changes/messages; all are
 * flattened. Status callbacks (delivery/read receipts) arrive on the same
 * endpoint with a `statuses` array and no `messages` — they parse to zero
 * messages, which the ingest pipeline treats as a no-op ACK.
 *
 * @param source adapter name, used only to prefix the thrown error so a
 *   malformed-envelope failure names the vendor that sent it.
 * @throws Error when the body is not a recognizable Meta envelope.
 */
export function parseMetaEnvelope(
  rawBody: string | Buffer,
  source: string,
): NormalizedInboundMessage[] {
  const parsed = inboundEnvelopeSchema.safeParse(
    JSON.parse(rawBody.toString('utf8')),
  );
  if (!parsed.success) {
    throw new Error(
      `${source}: unrecognized inbound webhook envelope: ${parsed.error.message}`,
    );
  }

  const messages: NormalizedInboundMessage[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const phoneNumberId = change.value.metadata?.phone_number_id;
      if (!phoneNumberId) {
        // Without it there is no tenant to resolve — skip rather than
        // throw, so one malformed change can't discard a sibling change's
        // perfectly valid messages.
        continue;
      }
      for (const message of change.value.messages ?? []) {
        const type = MESSAGE_TYPE_MAP[message.type] ?? 'unsupported';
        messages.push({
          phoneNumberId,
          bspMessageId: message.id,
          from: message.from,
          type,
          text: type === 'text' ? message.text?.body : undefined,
          media: extractMedia(message),
          receivedAt: parseTimestamp(message.timestamp),
        });
      }
    }
  }
  return messages;
}

/**
 * The media object on whichever key Meta put it under.
 *
 * Read for video and sticker too, even though both classify as
 * 'unsupported': the type says a human has to handle it, and the descriptor
 * is what lets that human actually SEE it. Dropping the id because we cannot
 * auto-answer the message is what made escalated media tickets useless.
 */
function extractMedia(message: {
  image?: z.infer<typeof mediaSchema>;
  audio?: z.infer<typeof mediaSchema>;
  voice?: z.infer<typeof mediaSchema>;
  video?: z.infer<typeof mediaSchema>;
  document?: z.infer<typeof mediaSchema>;
  sticker?: z.infer<typeof mediaSchema>;
}): InboundMediaDescriptor | undefined {
  const media =
    message.image ??
    message.audio ??
    message.voice ??
    message.video ??
    message.document ??
    message.sticker;
  if (!media) return undefined;

  return {
    mediaId: media.id,
    mimeType: media.mime_type ?? null,
    filename: media.filename ?? null,
    caption: media.caption ?? null,
  };
}

/**
 * Meta's status vocabulary -> the port's. 'sent'/'delivered'/'read'/'failed'
 * are the documented set; anything else (a status Meta adds later, or the
 * 'deleted' receipt) is dropped rather than guessed at — a wrong delivery
 * state shown to a human is worse than no state.
 */
const STATUS_MAP: Record<string, DeliveryStatus> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

/**
 * The other half of the same webhook body. Status callbacks and inbound
 * messages never arrive in the same change, but this parser makes no
 * assumption about that — it reads whatever `statuses` entries are present
 * and ignores everything else.
 *
 * Never throws on an unparseable body: a status callback is informational,
 * and rejecting the whole webhook delivery over one would make Meta retry a
 * payload that can never succeed. Inbound parsing keeps its strictness.
 */
export function parseMetaStatusUpdates(
  rawBody: string | Buffer,
): NormalizedStatusUpdate[] {
  let parsed: ReturnType<typeof inboundEnvelopeSchema.safeParse>;
  try {
    parsed = inboundEnvelopeSchema.safeParse(
      JSON.parse(rawBody.toString('utf8')),
    );
  } catch {
    return [];
  }
  if (!parsed.success) return [];

  const updates: NormalizedStatusUpdate[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const phoneNumberId = change.value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      for (const status of change.value.statuses ?? []) {
        const normalized = status.status
          ? STATUS_MAP[status.status]
          : undefined;
        if (!normalized || !status.id) continue;

        updates.push({
          phoneNumberId,
          bspMessageId: status.id,
          status: normalized,
          error: status.errors?.length
            ? status.errors.map(formatStatusError).join('; ')
            : null,
          occurredAt: parseTimestamp(status.timestamp ?? ''),
        });
      }
    }
  }
  return updates;
}

/**
 * Gulf T3 (D13): `smb_message_echoes` — what the business sent from the
 * WhatsApp Business app on a coexistence number. Meta's documented shape
 * ("Onboarding WhatsApp Business app users", verified 2026-09-19):
 *
 *   entry[].changes[] = { field: 'smb_message_echoes', value: {
 *     messaging_product, metadata: { display_phone_number, phone_number_id },
 *     message_echoes: [{ from, to, id, timestamp, type, <type>: {...} }] } }
 *
 * Its own schema rather than a widening of inboundEnvelopeSchema: an echo is
 * not a customer message, and nothing here may ever reach the inbound
 * (agent-answering) path.
 */
const echoEnvelopeSchema = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.string().optional(),
              value: z.object({
                metadata: z.object({ phone_number_id: z.string() }).optional(),
                message_echoes: z
                  .array(
                    z.object({
                      to: z.string().optional(),
                      id: z.string().optional(),
                      timestamp: z.string().optional(),
                      type: z.string().optional(),
                      text: z.object({ body: z.string() }).optional(),
                      image: mediaSchema.optional(),
                      audio: mediaSchema.optional(),
                      voice: mediaSchema.optional(),
                      video: mediaSchema.optional(),
                      document: mediaSchema.optional(),
                      sticker: mediaSchema.optional(),
                    }),
                  )
                  .optional(),
              }),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

/**
 * Never throws, same contract as parseMetaStatusUpdates: an echo is
 * informational, and rejecting a delivery over one would make Meta retry a
 * payload that can never succeed. Entries missing an id or a recipient are
 * dropped — there is nothing to file them under.
 */
export function parseMetaMessageEchoes(
  rawBody: string | Buffer,
): NormalizedMessageEcho[] {
  let parsed: ReturnType<typeof echoEnvelopeSchema.safeParse>;
  try {
    parsed = echoEnvelopeSchema.safeParse(JSON.parse(rawBody.toString('utf8')));
  } catch {
    return [];
  }
  if (!parsed.success) return [];

  const echoes: NormalizedMessageEcho[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const phoneNumberId = change.value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      for (const echo of change.value.message_echoes ?? []) {
        if (!echo.id || !echo.to) continue;
        const type = MESSAGE_TYPE_MAP[echo.type ?? ''] ?? 'unsupported';
        echoes.push({
          phoneNumberId,
          bspMessageId: echo.id,
          to: echo.to,
          type,
          text: type === 'text' ? echo.text?.body : undefined,
          media: extractMedia(echo),
          sentAt: parseTimestamp(echo.timestamp ?? ''),
        });
      }
    }
  }
  return echoes;
}

/** Meta often repeats itself — `title` and `message` come back identical on common failures — so parts are de-duplicated rather than concatenated verbatim into "X: X". */
function formatStatusError(error: {
  code?: number;
  title?: string;
  message?: string;
}): string {
  const parts = [error.code?.toString(), error.title, error.message].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  return [...new Set(parts)].join(': ');
}

/** Meta sends unix SECONDS as a string. A missing/garbage value falls back to now() rather than producing an Invalid Date that would poison downstream ordering. */
function parseTimestamp(raw: string): Date {
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000)
    : new Date();
}

/**
 * Meta's send response: `{"messages":[{"id":"wamid...."}]}`. Identical for
 * text and template sends.
 */
export function parseSentMessageId(body: unknown): string | undefined {
  const parsed = z
    .object({ messages: z.array(z.object({ id: z.string() })).min(1) })
    .safeParse(body);
  return parsed.success ? parsed.data.messages[0].id : undefined;
}
