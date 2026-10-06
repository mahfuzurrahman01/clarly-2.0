import { Injectable } from '@nestjs/common';
import { Clock } from './clock';

/** Default Clock binding — real wall-clock time. Bound in CoreModule. */
@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }

  nowMs(): number {
    return Date.now();
  }
}
