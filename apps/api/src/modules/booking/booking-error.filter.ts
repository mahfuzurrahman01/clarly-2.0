// Maps booking domain errors to HTTP. Thrown by BookingService, which stays
// free of Nest's HTTP exceptions so the agent tools can catch the same errors.
import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  BookingNotFoundError,
  BookingServiceNotFoundError,
  BookingSlotError,
  BookingsDisabledError,
  InvalidBookingTransitionError,
} from './booking-errors';

type BookingDomainError =
  | BookingNotFoundError
  | BookingServiceNotFoundError
  | BookingSlotError
  | BookingsDisabledError
  | InvalidBookingTransitionError;

@Catch(
  BookingNotFoundError,
  BookingServiceNotFoundError,
  BookingSlotError,
  BookingsDisabledError,
  InvalidBookingTransitionError,
)
export class BookingErrorFilter implements ExceptionFilter {
  catch(exception: BookingDomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const [status, error] =
      exception instanceof BookingNotFoundError ||
      exception instanceof BookingServiceNotFoundError
        ? [404, 'Not Found']
        : exception instanceof BookingsDisabledError
          ? [403, 'Forbidden']
          : [409, 'Conflict'];
    response.status(status).json({
      statusCode: status,
      message: exception.message,
      error,
      ...(exception instanceof BookingSlotError
        ? { reason: exception.reason }
        : {}),
    });
  }
}
