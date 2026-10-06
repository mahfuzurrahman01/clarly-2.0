import {
  parseMetaEnvelope,
  parseMetaMessageEchoes,
  parseMetaStatusUpdates,
} from './meta-envelope.parser';

// Gulf T3 (D13). Payload recorded from Meta's "Onboarding WhatsApp Business
// app users" docs (smb_message_echoes webhook).
describe('parseMetaMessageEchoes()', () => {
  const echoBody = (echoes: unknown[]) =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550001111',
                  phone_number_id: 'pn-1',
                },
                message_echoes: echoes,
              },
              field: 'smb_message_echoes',
            },
          ],
        },
      ],
    });

  it('normalizes a text echo: the customer is `to`, never `from`', () => {
    expect(
      parseMetaMessageEchoes(
        echoBody([
          {
            from: '15550001111',
            to: '15557654321',
            id: 'wamid.ECHO1',
            timestamp: '1758276000',
            type: 'text',
            text: { body: 'Sent from my phone' },
          },
        ]),
      ),
    ).toEqual([
      {
        phoneNumberId: 'pn-1',
        bspMessageId: 'wamid.ECHO1',
        to: '15557654321',
        type: 'text',
        text: 'Sent from my phone',
        media: undefined,
        sentAt: new Date(1758276000 * 1000),
      },
    ]);
  });

  it('keeps an image echo descriptor and caption', () => {
    const [echo] = parseMetaMessageEchoes(
      echoBody([
        {
          from: '15550001111',
          to: '15557654321',
          id: 'wamid.ECHO2',
          timestamp: '1758276000',
          type: 'image',
          image: { id: 'MEDIA_1', mime_type: 'image/jpeg', caption: 'Invoice' },
        },
      ]),
    );
    expect(echo.type).toBe('image');
    expect(echo.text).toBeUndefined();
    expect(echo.media).toEqual({
      mediaId: 'MEDIA_1',
      mimeType: 'image/jpeg',
      filename: null,
      caption: 'Invoice',
    });
  });

  it('drops an echo with no id or recipient, and never throws on garbage', () => {
    expect(
      parseMetaMessageEchoes(echoBody([{ from: 'x', type: 'text' }])),
    ).toEqual([]);
    expect(parseMetaMessageEchoes('not json')).toEqual([]);
    expect(parseMetaMessageEchoes(JSON.stringify({ entry: 'nope' }))).toEqual(
      [],
    );
  });

  it('is never read as an inbound customer message', () => {
    expect(
      parseMetaEnvelope(
        echoBody([
          {
            from: '15550001111',
            to: '15557654321',
            id: 'wamid.ECHO3',
            timestamp: '1758276000',
            type: 'text',
            text: { body: 'hi' },
          },
        ]),
        'test',
      ),
    ).toEqual([]);
  });

  it('finds no echoes in an ordinary inbound message webhook', () => {
    expect(
      parseMetaMessageEchoes(
        JSON.stringify({
          entry: [
            {
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: 'pn-1' },
                    messages: [
                      { from: '1', id: 'w', timestamp: '1', type: 'text' },
                    ],
                  },
                  field: 'messages',
                },
              ],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe('parseMetaStatusUpdates()', () => {
  const body = (statuses: unknown[]) =>
    JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'pn-1' },
                statuses,
              },
            },
          ],
        },
      ],
    });

  it('normalizes each documented status', () => {
    const updates = parseMetaStatusUpdates(
      body([
        { id: 'wamid.1', status: 'sent', timestamp: '1786627700' },
        { id: 'wamid.2', status: 'delivered', timestamp: '1786627701' },
        { id: 'wamid.3', status: 'read', timestamp: '1786627702' },
      ]),
    );

    expect(updates.map((update) => update.status)).toEqual([
      'sent',
      'delivered',
      'read',
    ]);
    expect(updates[0]).toMatchObject({
      phoneNumberId: 'pn-1',
      bspMessageId: 'wamid.1',
      error: null,
    });
  });

  it('keeps the vendor error detail on a failure, so a human is told why and not just that', () => {
    const [update] = parseMetaStatusUpdates(
      body([
        {
          id: 'wamid.9',
          status: 'failed',
          timestamp: '1786627700',
          errors: [
            {
              code: 131047,
              title: 'Re-engagement message',
              message: 'Message failed to send outside the 24 hour window.',
            },
          ],
        },
      ]),
    );

    expect(update.status).toBe('failed');
    expect(update.error).toContain('131047');
    expect(update.error).toContain('24 hour window');
  });

  it('drops a status it does not recognize rather than guessing — a wrong delivery state is worse than none', () => {
    expect(
      parseMetaStatusUpdates(
        body([{ id: 'wamid.1', status: 'deleted', timestamp: '1786627700' }]),
      ),
    ).toEqual([]);
  });

  it('returns nothing for an inbound-only body and for unparseable bytes, never throws', () => {
    expect(parseMetaStatusUpdates('{"entry":[]}')).toEqual([]);
    expect(parseMetaStatusUpdates('not json at all')).toEqual([]);
  });

  it('does not break inbound parsing of a body that also carries statuses', () => {
    const mixed = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'pn-1' },
                messages: [
                  {
                    from: '15551234567',
                    id: 'wamid.in',
                    timestamp: '1786627700',
                    type: 'text',
                    text: { body: 'hello' },
                  },
                ],
                statuses: [{ id: 'wamid.out', status: 'read' }],
              },
            },
          ],
        },
      ],
    });

    expect(parseMetaEnvelope(mixed, 'test')).toHaveLength(1);
    expect(parseMetaStatusUpdates(mixed)).toHaveLength(1);
  });
});

describe('parseMetaStatusUpdates() error formatting', () => {
  it('does not repeat a part Meta sent twice — title and message are identical on the most common failures', () => {
    const [update] = parseMetaStatusUpdates(
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: 'pn-1' },
                  statuses: [
                    {
                      id: 'wamid.1',
                      status: 'failed',
                      timestamp: '1786627700',
                      errors: [
                        {
                          code: 131047,
                          title: 'Re-engagement message',
                          message: 'Re-engagement message',
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    expect(update.error).toBe('131047: Re-engagement message');
  });
});

describe('parseMetaEnvelope() media extraction (F13)', () => {
  const body = (message: Record<string, unknown>) =>
    JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'pn-1' },
                messages: [
                  {
                    from: '+8801711000001',
                    id: 'wamid.MEDIA',
                    timestamp: '1786627708',
                    ...message,
                  },
                ],
              },
            },
          ],
        },
      ],
    });

  it('extracts an image descriptor and its caption', () => {
    const [message] = parseMetaEnvelope(
      body({
        type: 'image',
        image: {
          id: 'media-123',
          mime_type: 'image/jpeg',
          caption: 'this arrived broken',
        },
      }),
      'test',
    );

    expect(message.type).toBe('image');
    expect(message.media).toEqual({
      mediaId: 'media-123',
      mimeType: 'image/jpeg',
      filename: null,
      caption: 'this arrived broken',
    });
  });

  it('keeps a document filename', () => {
    const [message] = parseMetaEnvelope(
      body({
        type: 'document',
        document: {
          id: 'media-doc',
          mime_type: 'application/pdf',
          filename: 'invoice.pdf',
        },
      }),
      'test',
    );

    expect(message.media?.filename).toBe('invoice.pdf');
  });

  it('classifies a voice note as voice and still carries its media id', () => {
    const [message] = parseMetaEnvelope(
      body({ type: 'audio', audio: { id: 'media-voice' } }),
      'test',
    );

    expect(message.type).toBe('voice');
    expect(message.media?.mediaId).toBe('media-voice');
  });

  // The type says a human has to handle it; the descriptor is what lets that
  // human actually see it. Dropping the id is what made these tickets useless.
  it('carries the media id for an unsupported type like video', () => {
    const [message] = parseMetaEnvelope(
      body({
        type: 'video',
        video: { id: 'media-vid', mime_type: 'video/mp4' },
      }),
      'test',
    );

    expect(message.type).toBe('unsupported');
    expect(message.media?.mediaId).toBe('media-vid');
  });

  it('tolerates a media object with no mime_type', () => {
    const [message] = parseMetaEnvelope(
      body({ type: 'image', image: { id: 'media-bare' } }),
      'test',
    );

    expect(message.media).toEqual({
      mediaId: 'media-bare',
      mimeType: null,
      filename: null,
      caption: null,
    });
  });

  it('leaves media undefined on a text message', () => {
    const [message] = parseMetaEnvelope(
      body({ type: 'text', text: { body: 'hello' } }),
      'test',
    );

    expect(message.media).toBeUndefined();
    expect(message.text).toBe('hello');
  });

  it('leaves media undefined for a non-text type that carries none', () => {
    const [message] = parseMetaEnvelope(body({ type: 'location' }), 'test');

    expect(message.type).toBe('unsupported');
    expect(message.media).toBeUndefined();
  });
});
