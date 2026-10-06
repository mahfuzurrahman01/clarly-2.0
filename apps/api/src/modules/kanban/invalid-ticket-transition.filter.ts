// Product shell (KanbanModule): maps TicketModule's plain
// `InvalidTicketTransitionError` (deliberately not a NestJS
// HttpException — it's a domain error, reusable outside an HTTP context)
// to a 409 Conflict at the HTTP boundary. Without this filter it would
// fall through to Nest's default handler as an uncaught 500, which is the
// wrong status for "the ticket exists, but this transition from its
// current state isn't allowed."
import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { InvalidTicketTransitionError } from '../ticket/invalid-ticket-transition.error';

@Catch(InvalidTicketTransitionError)
export class InvalidTicketTransitionFilter implements ExceptionFilter {
  catch(exception: InvalidTicketTransitionError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(409).json({
      statusCode: 409,
      message: exception.message,
      error: 'Conflict',
    });
  }
}
