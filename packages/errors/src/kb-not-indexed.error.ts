import { AgentError } from './agent-error';

/** Tenant's knowledge base has no index yet, so retrieval cannot run. Owner: T1/A1. */
export class KBNotIndexed extends AgentError {
  constructor(message = 'Knowledge base is not indexed for this tenant') {
    super('KB_NOT_INDEXED', message);
  }
}
