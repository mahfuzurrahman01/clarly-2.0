// Proves the whole application graph actually wires up.
//
// Written after `main` shipped a bootstrap that could not start: when F13
// moved the `ObjectStorage` port into StorageModule, KnowledgeBaseModule kept
// exporting the bare token, which Nest rejects (a module may only export a
// provider it declares). Every one of the 1093 unit tests passed, because not
// one of them instantiates AppModule — each module is tested with hand-built
// fakes, so DI wiring was the one thing nothing covered.
//
// This is deliberately not an HTTP test. Its whole job is `AppModule`
// resolving: the failure it guards against happens before a single route is
// mounted.
//
// Requires real Postgres and Redis. Run via `npm run test:integration`.
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { EmailSender } from '../../src/modules/email/ports/email-sender.port';
import { KnowledgeBaseModule } from '../../src/modules/knowledge-base/knowledge-base.module';
import { ObjectStorage } from '../../src/modules/storage/ports/object-storage.port';

describe('AppModule bootstrap', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();
  }, 60000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('compiles and initialises the full module graph', () => {
    expect(moduleRef).toBeDefined();
  });

  it('resolves ObjectStorage through KnowledgeBaseModule, the backward-compatible path F13 promised', () => {
    expect(
      moduleRef.select(KnowledgeBaseModule).get(ObjectStorage),
    ).toBeDefined();
  });

  it('binds an EmailSender — the fail-closed no-op unless EMAIL_PROVIDER says otherwise', () => {
    expect(moduleRef.get(EmailSender)).toBeDefined();
  });
});
