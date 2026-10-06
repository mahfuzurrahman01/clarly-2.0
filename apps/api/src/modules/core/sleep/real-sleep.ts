import { Injectable } from '@nestjs/common';
import { Sleep } from './sleep';

/** Default Sleep binding — real setTimeout. Bound in CoreModule. */
@Injectable()
export class RealSleep extends Sleep {
  wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
