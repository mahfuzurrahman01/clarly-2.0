import { InvalidTicketTransitionError } from './invalid-ticket-transition.error';

describe('InvalidTicketTransitionError', () => {
  it('carries the from/to states in its message', () => {
    const error = new InvalidTicketTransitionError('RESOLVED', 'CLAIMED');

    expect(error.message).toBe(
      'Cannot transition ticket from RESOLVED to CLAIMED',
    );
    expect(error.name).toBe('InvalidTicketTransitionError');
    expect(error).toBeInstanceOf(Error);
  });
});
