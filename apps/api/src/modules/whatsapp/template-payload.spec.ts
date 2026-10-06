import { buildTemplatePayload } from './template-payload';

const base = {
  phoneNumberId: 'pn-1',
  to: '+8801711000001',
  templateName: 'order_shipped',
  language: 'en_US',
};

describe('buildTemplatePayload()', () => {
  it('builds a template send with positional body parameters', () => {
    expect(
      buildTemplatePayload({
        ...base,
        bodyParameters: ['Rina', 'A-4471'],
      }),
    ).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+8801711000001',
      type: 'template',
      template: {
        name: 'order_shipped',
        language: { code: 'en_US' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Rina' },
              { type: 'text', text: 'A-4471' },
            ],
          },
        ],
      },
    });
  });

  // Meta rejects `parameters: []` on a body component, which is a surprising
  // failure for the simplest possible template.
  it('omits components entirely for a template with no placeholders', () => {
    const payload = buildTemplatePayload({ ...base, bodyParameters: [] });

    expect(payload.template).toEqual({
      name: 'order_shipped',
      language: { code: 'en_US' },
    });
  });

  it('preserves parameter order — the array IS the {{1}}..{{n}} mapping', () => {
    const payload = buildTemplatePayload({
      ...base,
      bodyParameters: ['first', 'second', 'third'],
    });

    const { components } = payload.template as {
      components: { parameters: { text: string }[] }[];
    };
    expect(components[0].parameters.map((p) => p.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});
