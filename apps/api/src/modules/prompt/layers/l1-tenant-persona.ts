// D11 L1 — tenant persona/tone override (tenant_policy.tonePersonaOverride,
// Feature 2.5). Free text from a tenant admin, so it's sanitized here
// rather than trusted verbatim: length-capped and control-character
// stripped before ever reaching a prompt. This is presentation hygiene,
// not the D12 guardrail boundary — a tenant can still ask for a rude
// persona; this only stops the field from containing e.g. a stray escape
// sequence.
const MAX_PERSONA_LENGTH = 500;

// Strips C0 control characters and DEL, except \t (0x09) and \n (0x0A) —
// those two are legitimate formatting a tenant might reasonably use in a
// persona description.
// eslint-disable-next-line no-control-regex -- deliberately matching control characters to strip them.
const CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F]/g;

export function sanitizeTenantPersona(persona: string | null): string {
  if (!persona) return '';
  return persona.replace(CONTROL_CHARS, '').trim().slice(0, MAX_PERSONA_LENGTH);
}

export function renderL1TenantPersona(persona: string | null): string {
  const sanitized = sanitizeTenantPersona(persona);
  if (!sanitized) return '';
  return `## Persona and tone\n${sanitized}`;
}
