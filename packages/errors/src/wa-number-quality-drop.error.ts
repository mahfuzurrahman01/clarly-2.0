import { AgentError } from './agent-error';

/** BSP reported a phone-number quality-rating drop. Owner: T1/T4 (feeds AlertingModule). */
export class WANumberQualityDrop extends AgentError {
  constructor(message = 'WhatsApp sender number quality rating dropped') {
    super('WA_NUMBER_QUALITY_DROP', message);
  }
}
