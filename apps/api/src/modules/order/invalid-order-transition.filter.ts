// F25 D2.1: maps the domain `InvalidOrderTransitionError` to 409 at the HTTP
// boundary, mirroring `kanban/invalid-ticket-transition.filter.ts`.
//
// The error is deliberately not an HttpException — it is a domain error the
// expiry sweep and the push processor can also raise, outside any HTTP
// context. Without this filter it would fall through as an uncaught 500,
// which is the wrong status for "the order exists, but this transition from
// its current state is not allowed."
import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { InvalidOrderTransitionError } from './order-status-transition';

@Catch(InvalidOrderTransitionError)
export class InvalidOrderTransitionFilter implements ExceptionFilter {
  catch(exception: InvalidOrderTransitionError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(409).json({
      statusCode: 409,
      message: exception.message,
      error: 'Conflict',
    });
  }
}
