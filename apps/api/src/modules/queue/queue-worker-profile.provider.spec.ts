import { BullModule } from '@nestjs/bullmq';
import { Worker } from 'bullmq';
import type { AppConfigService } from '../core/config/app-config.service';
import type { AppLoggerService } from '../core/logger/app-logger.service';
import { LeanWorker } from './lean-worker';
import {
  queueWorkerProfileProvider,
  workerClassForProfile,
} from './queue-worker-profile.provider';

type ProfileFactory = (
  config: AppConfigService,
  logger: AppLoggerService,
) => string;

const log = jest.fn();
const logger = { log } as unknown as AppLoggerService;

function configWith(queueProfile: 'default' | 'lean'): AppConfigService {
  return { queueProfile } as AppConfigService;
}

describe('workerClassForProfile', () => {
  it("uses BullMQ's stock Worker for the default profile (zero behaviour change)", () => {
    expect(workerClassForProfile('default')).toBe(Worker);
  });

  it('uses LeanWorker for the lean profile', () => {
    expect(workerClassForProfile('lean')).toBe(LeanWorker);
  });
});

describe('queueWorkerProfileProvider', () => {
  const factory = (
    queueWorkerProfileProvider as unknown as { useFactory: ProfileFactory }
  ).useFactory;

  afterEach(() => {
    BullModule.workerClass = Worker;
    jest.restoreAllMocks();
  });

  it.each([
    ['default', Worker],
    ['lean', LeanWorker],
  ] as const)(
    'installs the %s worker class on @nestjs/bullmq before workers are created',
    (profile, expected) => {
      const setter = jest.spyOn(BullModule, 'workerClass', 'set');

      const resolved = factory(configWith(profile), logger);

      expect(setter).toHaveBeenCalledWith(expected);
      expect(resolved).toBe(profile);
      expect(log).toHaveBeenCalledWith(
        `Queue profile: ${profile}`,
        'QueueWorkerProfile',
      );
    },
  );
});
