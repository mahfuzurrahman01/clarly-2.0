// CI assertion: every NestJS module under apps/api/src is reachable from
// AppModule. See module-graph.ts for the three historical failures this
// exists to catch and for why the check is static rather than a Nest boot.
//
// This runs in the ordinary unit-test job (`pnpm --filter api run test`) and,
// because it needs no Postgres/Redis/provider keys, also as a fast standalone
// step in CI's `lint` job — see .github/workflows/ci.yml.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findModuleCycles,
  findOrphanModules,
  formatCycleFailure,
  formatOrphanFailure,
  reachableFrom,
  scanModuleGraph,
  type ModuleNode,
} from './module-graph';

const ROOT_MODULE = 'AppModule';
const SRC_DIR = join(__dirname);
const PACKAGE_ROOT = join(__dirname, '..');

/**
 * Modules that are deliberately outside AppModule's graph.
 *
 * EMPTY ON PURPOSE. Every `@Module()` in apps/api/src is currently reachable
 * from AppModule, and that is the state worth defending. An entry here is a
 * standing exemption from the only check that catches a dead module, so it
 * needs a comment giving the concrete reason the module cannot be registered
 * (e.g. "instantiated by hand in main.ts before the app factory runs"), not
 * "not wired up yet" — that is the bug this file exists to fail on.
 *
 * `findOrphanModules` throws if an entry here becomes stale (module deleted,
 * or module became reachable), so the list cannot silently rot.
 */
const MODULE_GRAPH_ALLOWLIST: readonly string[] = [];

describe('module graph — every NestJS module is reachable from AppModule', () => {
  const nodes = scanModuleGraph(SRC_DIR, PACKAGE_ROOT);

  it('scans the real source tree and finds AppModule plus the feature modules', () => {
    // A guard on the scanner itself: if the glob or the parser silently
    // stopped matching, the reachability assertion below would pass vacuously.
    expect(nodes.length).toBeGreaterThan(40);
    expect(nodes.map((node) => node.name)).toContain(ROOT_MODULE);
    expect(nodes.find((node) => node.name === ROOT_MODULE)?.file).toBe(
      'src/app.module.ts',
    );
  });

  it('has no orphaned modules', () => {
    const orphans = findOrphanModules(
      nodes,
      ROOT_MODULE,
      MODULE_GRAPH_ALLOWLIST,
    );
    if (orphans.length > 0) {
      throw new Error(formatOrphanFailure(orphans, ROOT_MODULE));
    }
    expect(orphans).toEqual([]);
  });

  it('counts a module reachable only transitively, not just one named in AppModule', () => {
    // MetaGraphModule is in neither AppModule.imports nor modules/index.ts; it
    // is reachable only through MetaChannelModule/CommentsModule/WhatsappModule.
    // A check that merely grepped app.module.ts would report it as an orphan.
    const reachable = reachableFrom(nodes, ROOT_MODULE);
    const appModule = nodes.find((node) => node.name === ROOT_MODULE);
    expect(appModule?.imports).not.toContain('MetaGraphModule');
    expect(reachable.has('MetaGraphModule')).toBe(true);
  });

  it('does not treat dynamically-registered external modules as graph nodes', () => {
    // QueueModule registers BullModule.forRootAsync({...}) and Observability
    // registers SentryModule.forRoot(). Neither declares a local @Module(), so
    // neither may ever be reported as an orphan.
    const names = nodes.map((node) => node.name);
    expect(names).not.toContain('BullModule');
    expect(names).not.toContain('SentryModule');
    expect(names).not.toContain('ConfigModule');
  });
});

describe('module graph — no circular module imports', () => {
  const nodes = scanModuleGraph(SRC_DIR, PACKAGE_ROOT);

  it('has no import cycle that Nest cannot resolve', () => {
    // The assertion that would have caught 2026-09-22's dead API. Reachability
    // (above) cannot: every module on that ring was reachable from AppModule.
    const cycles = findModuleCycles(nodes);
    if (cycles.length > 0) {
      throw new Error(formatCycleFailure(cycles));
    }
    expect(cycles).toEqual([]);
  });

  it('parses forwardRef edges out of the real tree rather than assuming there are none', () => {
    // A guard on the modelling itself: if `forwardRefImports` silently stopped
    // being populated, the assertion above would still pass but would have
    // become a blanket cycle ban, and the first legitimate forwardRef anyone
    // adds would fail CI for no reason. This only checks the field exists and
    // is always a subset of `imports` — the repo currently has no forwardRef,
    // and that is a fine state, not one to assert against.
    for (const node of nodes) {
      expect(Array.isArray(node.forwardRefImports)).toBe(true);
      for (const name of node.forwardRefImports ?? []) {
        expect(node.imports).toContain(name);
      }
    }
  });
});

describe('module graph — regression fixtures for the three historical failures', () => {
  // Each fixture reproduces a real shape as actual .module.ts source, parsed by
  // the real scanner, so the test proves the check catches the bug without
  // un-registering a live module.
  let dir: string;

  const write = (relativePath: string, source: string): void => {
    const path = join(dir, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, source);
  };

  /** A minimal `@Module()` file. */
  const moduleSource = (
    name: string,
    imports: readonly string[] = [],
  ): string =>
    [
      "import { Module } from '@nestjs/common';",
      `@Module({ imports: [${imports.join(', ')}] })`,
      `export class ${name} {}`,
      '',
    ].join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'module-graph-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('F24 / StoreModule (95c06f5): a module absent from AppModule.imports AND the barrel', () => {
    // The shape that actually shipped: store.module.ts existed and compiled,
    // nothing anywhere referenced StoreModule, every /store/* route 404'd until
    // c02f756 registered it. `export * from` in the barrel is irrelevant to
    // reachability, which is the point — the barrel is included here to prove
    // that adding it back would NOT have satisfied this check.
    write('app.module.ts', moduleSource('AppModule', ['CatalogModule']));
    write('modules/index.ts', "export * from './store/store.module';\n");
    write('modules/catalog/catalog.module.ts', moduleSource('CatalogModule'));
    write('modules/store/store.module.ts', moduleSource('StoreModule'));

    const orphans = findOrphanModules(scanModuleGraph(dir), ROOT_MODULE);

    expect(orphans.map((orphan) => orphan.name)).toEqual(['StoreModule']);
    expect(orphans[0].importedByUnreachable).toEqual([]);
    const message = formatOrphanFailure(orphans, ROOT_MODULE);
    expect(message).toContain('StoreModule');
    expect(message).toContain('modules/store/store.module.ts');
    expect(message).toContain('Nothing imports it');
  });

  it('F19 / CampaignModule (b3ea688): a whole feature module nothing references', () => {
    // Caught by hand seconds before the commit; /segments and /campaigns would
    // have 404'd. Same shape as F24, alongside a sibling that IS registered —
    // the check must flag exactly one of them, not both and not neither.
    write(
      'app.module.ts',
      moduleSource('AppModule', ['CustomerModule', 'WebhookModule']),
    );
    write(
      'modules/customer/customer.module.ts',
      moduleSource('CustomerModule'),
    );
    write('modules/webhook/webhook.module.ts', moduleSource('WebhookModule'));
    write(
      'modules/campaign/campaign.module.ts',
      moduleSource('CampaignModule', ['CustomerModule']),
    );

    const orphans = findOrphanModules(scanModuleGraph(dir), ROOT_MODULE);

    // CampaignModule importing a live module does not make CampaignModule live:
    // edges are directed, and reachability only runs outward from AppModule.
    expect(orphans.map((orphan) => orphan.name)).toEqual(['CampaignModule']);
    expect(formatOrphanFailure(orphans, ROOT_MODULE)).toContain(
      'modules/campaign/campaign.module.ts',
    );
  });

  it('F25 / OrderModule (2cf5d85): a module imported only by another orphan is still dead', () => {
    // The shape a naive "does the class name appear anywhere" check misses, and
    // the one F25 was one commit away from: OrderModule registered on
    // CourierModule rather than on AppModule, with CourierModule itself never
    // registered. Both are dead; the message must say so and must point at the
    // importer rather than sending someone to re-register the leaf.
    write('app.module.ts', moduleSource('AppModule', ['CatalogModule']));
    write('modules/catalog/catalog.module.ts', moduleSource('CatalogModule'));
    write(
      'modules/courier/courier.module.ts',
      moduleSource('CourierModule', ['OrderModule']),
    );
    write(
      'modules/order/order.module.ts',
      moduleSource('OrderModule', ['CatalogModule']),
    );

    const orphans = findOrphanModules(scanModuleGraph(dir), ROOT_MODULE);

    expect(orphans.map((orphan) => orphan.name).sort()).toEqual([
      'CourierModule',
      'OrderModule',
    ]);
    const order = orphans.find((orphan) => orphan.name === 'OrderModule');
    expect(order?.importedByUnreachable).toEqual(['CourierModule']);

    const message = formatOrphanFailure(orphans, ROOT_MODULE);
    expect(message).toContain('Imported only by: CourierModule');
    expect(message).toContain('themselves unreachable');
  });
});

describe('module graph — cycle regression fixtures', () => {
  let dir: string;

  const write = (relativePath: string, source: string): void => {
    const path = join(dir, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, source);
  };

  const moduleSource = (
    name: string,
    imports: readonly string[] = [],
  ): string =>
    [
      "import { Module, forwardRef } from '@nestjs/common';",
      `@Module({ imports: [${imports.join(', ')}] })`,
      `export class ${name} {}`,
      '',
    ].join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'module-graph-cycle-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The exact ring that killed the API on 2026-09-22, as source.
   *
   * `2cf5d85` (Phase 7 / F25) added ToolExecutionModule -> OrderModule and
   * OrderModule -> StoreModule. Every other edge, including the fatal one
   * (AuditModule -> OnboardingModule, taken for one provider,
   * TenantAuthProvisioningPort), predated it. Boot died with
   * UndefinedModuleException; build and 3090 unit specs stayed green.
   */
  const F25_RING = [
    ['OnboardingModule', 'AgentConfigModule'],
    ['AgentConfigModule', 'AgentModule'],
    ['AgentModule', 'ToolExecutionModule'],
    ['ToolExecutionModule', 'OrderModule'],
    ['OrderModule', 'StoreModule'],
    ['StoreModule', 'CustomerModule'],
    ['CustomerModule', 'AuditModule'],
    ['AuditModule', 'OnboardingModule'],
  ] as const;

  const writeRing = (closingEdge: readonly [string, string, string?]): void => {
    write('app.module.ts', moduleSource('AppModule', ['OnboardingModule']));
    for (const [from, to] of F25_RING) {
      const edge =
        from === closingEdge[0] && closingEdge[2] === 'forwardRef'
          ? `forwardRef(() => ${to})`
          : to;
      write(`modules/${from}.module.ts`, moduleSource(from, [edge]));
    }
  };

  it('F25 (2cf5d85): the eight-module ring that stopped the API booting', () => {
    writeRing(['', '']);
    const nodes = scanModuleGraph(dir);

    // Reachability sees nothing wrong — which is the whole point of this test.
    expect(findOrphanModules(nodes, ROOT_MODULE)).toEqual([]);

    const cycles = findModuleCycles(nodes);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].path).toEqual([
      'OnboardingModule',
      'AgentConfigModule',
      'AgentModule',
      'ToolExecutionModule',
      'OrderModule',
      'StoreModule',
      'CustomerModule',
      'AuditModule',
      'OnboardingModule',
    ]);

    const message = formatCycleFailure(cycles);
    // Shaped like the Nest trace the developer would otherwise see at boot.
    expect(message).toContain(
      'Scope [OnboardingModule -> AgentConfigModule -> AgentModule -> ' +
        'ToolExecutionModule -> OrderModule -> StoreModule -> CustomerModule ' +
        '-> AuditModule -> OnboardingModule]',
    );
    expect(message).toContain('AuditModule imports OnboardingModule');
    expect(message).toContain('UndefinedModuleException');
  });

  it('the same ring is clean once the reach-back edge is cut (the fix that shipped)', () => {
    // AuditModule imports the leaf TenantAuthProvisioningModule for the port
    // instead of the whole OnboardingModule — the change this check defends.
    write('app.module.ts', moduleSource('AppModule', ['OnboardingModule']));
    for (const [from, to] of F25_RING) {
      write(
        `modules/${from}.module.ts`,
        moduleSource(
          from,
          from === 'AuditModule' ? ['TenantAuthProvisioningModule'] : [to],
        ),
      );
    }
    write(
      'modules/TenantAuthProvisioningModule.module.ts',
      moduleSource('TenantAuthProvisioningModule', ['CoreModule']),
    );
    write('modules/CoreModule.module.ts', moduleSource('CoreModule'));

    expect(findModuleCycles(scanModuleGraph(dir))).toEqual([]);
  });

  it('allows a cycle that is deliberately broken with forwardRef', () => {
    // forwardRef is Nest's supported way to declare a cycle, and Nest boots
    // fine with one. A check that banned all cycles would be wrong, and would
    // be turned off the first time someone legitimately needed one.
    writeRing(['AuditModule', 'OnboardingModule', 'forwardRef']);
    const nodes = scanModuleGraph(dir);

    const audit = nodes.find((node) => node.name === 'AuditModule');
    expect(audit?.imports).toEqual(['OnboardingModule']);
    expect(audit?.forwardRefImports).toEqual(['OnboardingModule']);
    expect(findModuleCycles(nodes)).toEqual([]);
  });

  it('still reports a ring where only SOME edges are forwardRef', () => {
    // One forwardRef somewhere on the graph does not license every other ring.
    write('app.module.ts', moduleSource('AppModule', ['AModule']));
    write(
      'modules/a.module.ts',
      moduleSource('AModule', ['forwardRef(() => BModule)', 'CModule']),
    );
    write('modules/b.module.ts', moduleSource('BModule', ['AModule']));
    write('modules/c.module.ts', moduleSource('CModule', ['DModule']));
    write('modules/d.module.ts', moduleSource('DModule', ['AModule']));

    const cycles = findModuleCycles(scanModuleGraph(dir));

    // A -> B -> A is excused by the forwardRef; A -> C -> D -> A is not.
    expect(cycles.map((cycle) => cycle.path)).toEqual([
      ['AModule', 'CModule', 'DModule', 'AModule'],
    ]);
  });

  it('reports a module that imports itself', () => {
    write('app.module.ts', moduleSource('AppModule', ['SelfModule']));
    write('modules/self.module.ts', moduleSource('SelfModule', ['SelfModule']));

    expect(findModuleCycles(scanModuleGraph(dir)).map((c) => c.path)).toEqual([
      ['SelfModule', 'SelfModule'],
    ]);
  });

  it('finds a cycle among modules that are unreachable from AppModule', () => {
    // Orphan-hood and cyclicity are independent defects; neither check may
    // depend on the other having passed first.
    write('app.module.ts', moduleSource('AppModule'));
    write('modules/x.module.ts', moduleSource('XModule', ['YModule']));
    write('modules/y.module.ts', moduleSource('YModule', ['XModule']));

    expect(findModuleCycles(scanModuleGraph(dir))).toHaveLength(1);
  });

  it('does not mistake a diamond for a cycle', () => {
    // Two paths to the same module is the normal shape of this graph
    // (PersistenceModule has dozens of importers) and must never be reported.
    write(
      'app.module.ts',
      moduleSource('AppModule', ['LeftModule', 'RightModule']),
    );
    write(
      'modules/left.module.ts',
      moduleSource('LeftModule', ['SharedModule']),
    );
    write(
      'modules/right.module.ts',
      moduleSource('RightModule', ['SharedModule']),
    );
    write('modules/shared.module.ts', moduleSource('SharedModule'));

    expect(findModuleCycles(scanModuleGraph(dir))).toEqual([]);
  });
});

describe('module graph — no false positives on legitimately dynamic registration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'module-graph-dyn-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves forRoot/forRootAsync, forwardRef, conditional spreads and registerQueue', () => {
    writeFileSync(
      join(dir, 'app.module.ts'),
      [
        "import { Module, forwardRef } from '@nestjs/common';",
        "import { BullModule } from '@nestjs/bullmq';",
        "import { SentryModule } from '@sentry/nestjs';",
        "const RESPOND_PATH_QUEUE = 'respond-path';",
        '@Module({',
        '  imports: [',
        '    SentryModule.forRoot(),',
        '    BullModule.forRootAsync({ useFactory: () => ({}) }),',
        '    BullModule.registerQueue({ name: RESPOND_PATH_QUEUE }),',
        '    QueueModule.forRoot({ prefix: 1 }),',
        '    forwardRef(() => AgentModule),',
        '    ...(process.env.FLAG ? [BillingModule] : []),',
        '  ],',
        '})',
        'export class AppModule {}',
        '',
      ].join('\n'),
    );
    for (const name of ['QueueModule', 'AgentModule', 'BillingModule']) {
      writeFileSync(
        join(dir, `${name.toLowerCase()}.module.ts`),
        `import { Module } from '@nestjs/common';\n@Module({})\nexport class ${name} {}\n`,
      );
    }

    const nodes = scanModuleGraph(dir);

    expect(findOrphanModules(nodes, ROOT_MODULE)).toEqual([]);
    // The queue-name constant must not be mistaken for a module reference, and
    // external modules must not become graph nodes.
    expect(nodes.map((node) => node.name).sort()).toEqual([
      'AgentModule',
      'AppModule',
      'BillingModule',
      'QueueModule',
    ]);
  });
});

describe('module graph — allowlist hygiene', () => {
  const graph: ModuleNode[] = [
    { name: 'AppModule', file: 'src/app.module.ts', imports: ['LiveModule'] },
    {
      name: 'LiveModule',
      file: 'src/modules/live/live.module.ts',
      imports: [],
    },
    {
      name: 'DeadModule',
      file: 'src/modules/dead/dead.module.ts',
      imports: [],
    },
  ];

  it('suppresses exactly the allowlisted module and nothing else', () => {
    expect(findOrphanModules(graph, 'AppModule', ['DeadModule'])).toEqual([]);
    expect(
      findOrphanModules(graph, 'AppModule').map((orphan) => orphan.name),
    ).toEqual(['DeadModule']);
  });

  it('rejects an allowlist entry for a module that no longer exists', () => {
    expect(() => findOrphanModules(graph, 'AppModule', ['GoneModule'])).toThrow(
      /Stale module-graph allowlist entry: GoneModule no longer exists/,
    );
  });

  it('rejects an allowlist entry for a module that has since been registered', () => {
    expect(() => findOrphanModules(graph, 'AppModule', ['LiveModule'])).toThrow(
      /Stale module-graph allowlist entry: LiveModule is now reachable/,
    );
  });

  it('rejects a root module that does not exist rather than reporting everything as an orphan', () => {
    expect(() => findOrphanModules(graph, 'RenamedAppModule')).toThrow(
      /Root module RenamedAppModule was not found/,
    );
    expect(reachableFrom(graph, 'RenamedAppModule').size).toBe(0);
  });

  it('rejects two @Module() classes sharing a name, since edges resolve by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'module-graph-dup-'));
    try {
      for (const name of ['a', 'b']) {
        writeFileSync(
          join(dir, `${name}.module.ts`),
          `import { Module } from '@nestjs/common';\n@Module({})\nexport class DupModule {}\n`,
        );
      }
      expect(() => scanModuleGraph(dir)).toThrow(
        /Two files declare a @Module\(\) class named DupModule/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
