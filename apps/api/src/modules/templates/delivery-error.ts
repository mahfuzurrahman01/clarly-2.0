// ISSUE-002: the operator-facing wording of a failed template send.
//
// The raw error carries the adapter's own log phrasing ("MetaCloudAdapter:
// send failed with HTTP 404: (#132001) ..."), which is useful in server logs
// and noise in a console. What an operator needs is Meta's code and Meta's
// message, so this keeps those and drops the plumbing. The unsanitised error
// is still logged by TemplateSendService.
import { MetaGraphError } from '../meta-graph/meta-graph.error';

/** `<Class>: <operation> failed with HTTP <n>: ` — the prefix withOperation() adds. */
const OPERATION_PREFIX = /^(?:[A-Za-z]+:\s*)?[^:]*?failed with HTTP \d+:\s*/;
/** A bare `ClassName: ` left on errors that never went through withOperation(). */
const CLASS_PREFIX = /^[A-Z][A-Za-z]+(?:Adapter|Client|Service|Error):\s*/;
const META_CODE = /^\(#(\d+)\)\s*/;

export function toOperatorDeliveryError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const stripped = raw.replace(OPERATION_PREFIX, '').replace(CLASS_PREFIX, '');

  const embedded = META_CODE.exec(stripped);
  const code =
    embedded?.[1] ??
    (error instanceof MetaGraphError && error.code !== null
      ? String(error.code)
      : null);
  const message = stripped.replace(META_CODE, '').trim();

  if (error instanceof MetaGraphError || embedded) {
    return code
      ? `WhatsApp rejected the send (#${code}): ${message}`
      : `WhatsApp rejected the send: ${message}`;
  }
  return message || 'send failed';
}
