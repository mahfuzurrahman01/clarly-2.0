/**
 * T6: "webhook for an unrecognized phone_number_id is rejected before any
 * tenant context is entered, not silently misrouted." Thrown by
 * WhatsappNumberResolutionService before any withTenantTx() call happens —
 * there is no tenant to scope a transaction to yet.
 */
export class UnknownWhatsappNumberError extends Error {
  constructor() {
    super('No tenant is connected to this WhatsApp number.');
    this.name = 'UnknownWhatsappNumberError';
  }
}
