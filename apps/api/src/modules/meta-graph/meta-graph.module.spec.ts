import type { AppConfigService, AppLoggerService } from '../core';
import { MetaGraphModule } from './meta-graph.module';

describe('MetaGraphModule', () => {
  it('logs each deprecated META_SOCIAL_* alias warning once at startup (D8)', () => {
    const warn = jest.fn();
    const module = new MetaGraphModule(
      {
        deprecatedMetaEnvWarnings: ['alias one', 'alias two'],
      } as unknown as AppConfigService,
      { warn } as unknown as AppLoggerService,
    );

    module.onModuleInit();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, 'alias one', 'MetaGraphModule');
    expect(warn).toHaveBeenNthCalledWith(2, 'alias two', 'MetaGraphModule');
  });

  it('stays silent when no alias is set', () => {
    const warn = jest.fn();
    new MetaGraphModule(
      { deprecatedMetaEnvWarnings: [] } as unknown as AppConfigService,
      { warn } as unknown as AppLoggerService,
    ).onModuleInit();

    expect(warn).not.toHaveBeenCalled();
  });
});
