/** Product-shell business-rule error (not a T1/@repo/errors AI-pipeline exception) — a kanban-console-level state-machine violation, e.g. claiming an already-resolved ticket. */
export class InvalidTicketTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot transition ticket from ${from} to ${to}`);
    this.name = 'InvalidTicketTransitionError';
  }
}
