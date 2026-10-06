import { AppConfigService } from '../config/app-config.service';
import { AppLoggerService } from './app-logger.service';

interface ParsedLogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: string;
  trace?: string;
}

function makeConfig(nodeEnv: 'development' | 'production'): AppConfigService {
  return { nodeEnv } as AppConfigService;
}

function parseLoggedEntry(
  spy: jest.SpyInstance,
  callIndex = 0,
): ParsedLogEntry {
  const calls = spy.mock.calls as unknown as string[][];
  return JSON.parse(calls[callIndex][0]) as ParsedLogEntry;
}

describe('AppLoggerService', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('emits single-line JSON with timestamp/level/message', () => {
    const logger = new AppLoggerService(makeConfig('development'));

    logger.log('hello', 'TestContext');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const entry = parseLoggedEntry(logSpy);
    expect(entry).toMatchObject({
      level: 'log',
      message: 'hello',
      context: 'TestContext',
    });
    expect(typeof entry.timestamp).toBe('string');
  });

  it('routes error/fatal to console.error, everything else to console.log', () => {
    const logger = new AppLoggerService(makeConfig('development'));

    logger.error('boom');
    logger.warn('careful');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('includes the stack trace as `trace` when error() is called with one', () => {
    const logger = new AppLoggerService(makeConfig('development'));

    logger.error('boom', 'stack-trace-text');

    const entry = parseLoggedEntry(errorSpy);
    expect(entry.trace).toBe('stack-trace-text');
  });

  it('unwraps Error instances to their .message', () => {
    const logger = new AppLoggerService(makeConfig('development'));

    logger.log(new Error('something broke'));

    const entry = parseLoggedEntry(logSpy);
    expect(entry.message).toBe('something broke');
  });

  it('in production, suppresses verbose/debug below the "log" floor', () => {
    const logger = new AppLoggerService(makeConfig('production'));

    logger.verbose('too chatty');
    logger.debug('also too chatty');
    logger.log('this one ships');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const entry = parseLoggedEntry(logSpy);
    expect(entry.message).toBe('this one ships');
  });

  it('in development, verbose/debug are not suppressed', () => {
    const logger = new AppLoggerService(makeConfig('development'));

    logger.verbose('chatty but allowed');

    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
