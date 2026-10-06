/** The agent may not book: no settings row, or mode `disabled`. */
export class BookingsDisabledError extends Error {
  constructor() {
    super('Bookings are not enabled for this workspace.');
    this.name = 'BookingsDisabledError';
  }
}

export class BookingServiceNotFoundError extends Error {
  constructor() {
    super('No such active service.');
    this.name = 'BookingServiceNotFoundError';
  }
}

export type SlotRefusal =
  'closed' | 'too_soon' | 'taken' | 'invalid_time' | 'out_of_range';

/** The requested time cannot be booked; `reason` says why. */
export class BookingSlotError extends Error {
  constructor(readonly reason: SlotRefusal) {
    super(`That time cannot be booked (${reason}).`);
    this.name = 'BookingSlotError';
  }
}

export class BookingNotFoundError extends Error {
  constructor() {
    super('Booking not found.');
    this.name = 'BookingNotFoundError';
  }
}

/** A transition the booking's current status does not allow. */
export class InvalidBookingTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`A ${from} booking cannot become ${to}.`);
    this.name = 'InvalidBookingTransitionError';
  }
}
