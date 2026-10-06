// Channel (WhatsappModule, F12): the Meta template send payload.
//
// A pure function, kept apart from MetaCloudAdapter for the same reason
// meta-envelope.parser is: the components array is easy to get wrong, so it
// is tested on its own.
import type { SendTemplateMessageParams } from './ports/bsp-adapter.port';

/**
 * Builds the `messages` request body for a template send.
 *
 * The `components` array is omitted entirely when a template takes no
 * parameters — Meta rejects an empty `parameters: []` on a body component,
 * which is a surprising failure for the simplest possible template.
 */
export function buildTemplatePayload(
  params: SendTemplateMessageParams,
): Record<string, unknown> {
  const components =
    params.bodyParameters.length > 0
      ? [
          {
            type: 'body',
            // Positional and ordered — this array IS the {{1}}..{{n}} mapping.
            parameters: params.bodyParameters.map((text) => ({
              type: 'text',
              text,
            })),
          },
        ]
      : undefined;

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: params.to,
    type: 'template',
    template: {
      name: params.templateName,
      language: { code: params.language },
      ...(components ? { components } : {}),
    },
  };
}
