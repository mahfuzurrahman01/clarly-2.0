// Module-graph reachability analysis for apps/api.
//
// WHY THIS EXISTS
// ---------------
// Three times a NestJS module has shipped (or nearly shipped) registered
// nowhere in the dependency graph:
//
//   * F24 `StoreModule` (`95c06f5`) — landed as a self-contained module that
//     nothing imported; missing from BOTH `AppModule.imports` and the
//     `modules/index.ts` barrel. Every `/store/*` route 404'd until `c02f756`
//     wired it in. See docs/GULF_PARITY_PLAN.md "Phase 6 — Commerce core".
//   * F19 `CampaignModule` (`b3ea688`) — the same shape, caught by hand just
//     before the commit; every `/segments` and `/campaigns` route would have
//     404'd. See docs/SESSION_HANDOFF_2026-09-21.md, item 2 of the F19 recovery.
//   * F20/F25 (`c5e8b9f`, `2cf5d85`) — the modules themselves were registered,
//     but the near-misses in the same commits (`lookup_product` /
//     `create_order` absent from `TOOL_DEFINITIONS`, a migration absent from
//     Drizzle's journal) are the same defect class: a unit that compiles,
//     passes every test, boots fine, and is reachable from nothing.
//
// Nothing catches this class of bug: the app still boots, `nest build` still
// passes, every unit spec still passes, and the only symptom is a 404 at
// runtime. So it needs its own assertion.
//
// STATIC, NOT A RUNTIME BOOT
// --------------------------
// This parses the module graph out of source rather than booting a Nest
// testing module and inspecting the container. A boot would prove
// reachability for real, but `AppModule` transitively pulls in Postgres,
// Redis/BullMQ, Supabase, Stripe and the LLM providers — it needs live
// services and provider keys, which is exactly the surface the CI unit-test
// job is designed not to need, and it would be slow and flaky besides.
//
// The usual weakness of a static walk is dynamic registration
// (`forRoot`/`forRootAsync`/`registerQueue`, conditional spreads, barrel
// re-exports). This implementation is immune to all three:
//
//   * Edges are resolved BY CLASS NAME, not by following import specifiers,
//     so `export * from './catalog/catalog.module'` barrels and deep relative
//     paths are irrelevant — `MetaGraphModule`, which is in no barrel and in
//     no `AppModule.imports`, is correctly seen as reachable through
//     `MetaChannelModule` and `CommentsModule`.
//   * Every identifier inside an `imports: [...]` element is collected,
//     however it is nested — `X.forRoot()`, `...(flag ? [X] : [])`,
//     `forwardRef(() => X)` all yield `X`.
//   * Identifiers that name no local `@Module()` class (`BullModule`,
//     `SentryModule`, queue-name constants) are simply not edges. An external
//     dynamic module can therefore never be reported as an orphan.
//
// The one thing it cannot see is a module registered somewhere other than an
// `imports` array (e.g. built by hand in `main.ts`). That is what `allowlist`
// is for, and an allowlist entry must be commented at its definition site.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ts from 'typescript';

/** One `@Module()`-decorated class found in the source tree. */
export interface ModuleNode {
  /** The class name, e.g. `CatalogModule`. This is the graph's node id. */
  readonly name: string;
  /** Path to the declaring file, relative to the package root, POSIX-style. */
  readonly file: string;
  /** Class names referenced anywhere inside this module's `imports: [...]`. */
  readonly imports: readonly string[];
  /**
   * The subset of {@link imports} wrapped in `forwardRef(() => X)`.
   *
   * A `forwardRef` is the explicit, documented way to tell Nest that an edge
   * closes a cycle on purpose, and Nest resolves such a cycle rather than
   * refusing to build the container. {@link findModuleCycles} therefore
   * ignores these edges: a ring is only a defect if EVERY edge on it is a
   * plain import. Optional so hand-built {@link ModuleNode} fixtures (which
   * have no forwardRefs by construction) stay valid.
   */
  readonly forwardRefImports?: readonly string[];
}

/** One import edge on a cycle, in the order the cycle is walked. */
export interface CycleEdge {
  readonly from: string;
  readonly to: string;
}

/**
 * A ring of `imports` edges, none of which is a `forwardRef`.
 *
 * `path` starts and ends on the same module, so `[A, B, C, A]` reads exactly
 * like the `Scope [...]` trace Nest prints when it gives up.
 */
export interface ModuleCycle {
  readonly path: readonly string[];
  readonly edges: readonly CycleEdge[];
}

/** An orphan plus the reason it is being reported, for the failure message. */
export interface Orphan {
  readonly name: string;
  readonly file: string;
  /**
   * Modules that DO import this one, all of which are themselves unreachable.
   * Empty means nothing imports it at all. The distinction matters: an empty
   * list means "add it to AppModule.imports", a non-empty one means "the
   * importer is dead too — fix that first".
   */
  readonly importedByUnreachable: readonly string[];
}

const MODULE_FILE_SUFFIX = '.module.ts';

/**
 * Walk `dir` recursively and parse every `*.module.ts` into a {@link ModuleNode}.
 *
 * @throws if two files declare `@Module()` classes with the same name — edges
 * are resolved by name, so a collision would make the graph ambiguous.
 */
export function scanModuleGraph(
  dir: string,
  packageRoot: string = dir,
): ModuleNode[] {
  const nodes: ModuleNode[] = [];
  for (const file of findModuleFiles(dir)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
    );
    const relativeFile = relative(packageRoot, file).split(sep).join('/');
    nodes.push(...parseModuleFile(source, relativeFile));
  }

  const seen = new Map<string, string>();
  for (const node of nodes) {
    const previous = seen.get(node.name);
    if (previous !== undefined) {
      throw new Error(
        `Two files declare a @Module() class named ${node.name}: ${previous} and ${node.file}. ` +
          'Module-graph edges are resolved by class name, so names must be unique. Rename one.',
      );
    }
    seen.set(node.name, node.file);
  }
  return nodes;
}

/** Every `*.module.ts` under `dir`, recursively, sorted for stable output. */
function findModuleFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') found.push(...findModuleFiles(path));
    } else if (entry.name.endsWith(MODULE_FILE_SUFFIX)) {
      found.push(path);
    }
  }
  return found.sort();
}

/** Extract every `@Module()`-decorated class declared in one source file. */
function parseModuleFile(source: ts.SourceFile, file: string): ModuleNode[] {
  const nodes: ModuleNode[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const decorator = findModuleDecorator(node);
      if (decorator) {
        const { imports, forwardRefImports } =
          collectImportedModuleNames(decorator);
        nodes.push({ name: node.name.text, file, imports, forwardRefImports });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes;
}

/** The object literal passed to `@Module({...})`, if the class has one. */
function findModuleDecorator(
  node: ts.ClassDeclaration,
): ts.ObjectLiteralExpression | undefined {
  for (const decorator of ts.getDecorators(node) ?? []) {
    const call = decorator.expression;
    if (!ts.isCallExpression(call)) continue;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== 'Module')
      continue;
    const [arg] = call.arguments;
    if (arg && ts.isObjectLiteralExpression(arg)) return arg;
  }
  return undefined;
}

/**
 * Every identifier appearing inside the decorator's `imports: [...]`, plus the
 * subset of them that appeared inside a `forwardRef(...)`.
 *
 * Deliberately over-collects: `X.forRoot()`, `forwardRef(() => X)` and
 * `...(flag ? [X] : [])` all contribute `X`, and anything that turns out not
 * to name a local module is discarded later by the reachability walk. Property
 * names (`BullModule.registerQueue({ name: Q })`) are skipped so an object key
 * can never masquerade as a module reference.
 *
 * `forwardRef` itself is the one identifier never collected — it is the
 * wrapper, not the module. Anything else named inside the arrow body is
 * recorded as a forward reference, which is what makes the cycle check able to
 * tell a deliberate cycle from an accidental one.
 */
function collectImportedModuleNames(decorator: ts.ObjectLiteralExpression): {
  imports: string[];
  forwardRefImports: string[];
} {
  const importsProperty = decorator.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === 'imports',
  );
  if (!importsProperty) return { imports: [], forwardRefImports: [] };

  const names = new Set<string>();
  const deferred = new Set<string>();
  const visit = (node: ts.Node, insideForwardRef: boolean): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'forwardRef'
    ) {
      for (const argument of node.arguments) visit(argument, true);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      // `A.b` — take the object, never the `.b`.
      visit(node.expression, insideForwardRef);
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      // `{ name: Q }` — the value can still reference a module; the key cannot.
      visit(node.initializer, insideForwardRef);
      return;
    }
    if (ts.isIdentifier(node)) {
      names.add(node.text);
      if (insideForwardRef) deferred.add(node.text);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, insideForwardRef));
  };
  visit(importsProperty.initializer, false);
  return { imports: [...names], forwardRefImports: [...deferred] };
}

/**
 * Class names reachable from `rootName` by following `imports` edges.
 * Edges to names that are not in `nodes` (external modules like `BullModule`)
 * are ignored.
 */
export function reachableFrom(
  nodes: readonly ModuleNode[],
  rootName: string,
): Set<string> {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const reachable = new Set<string>();
  const queue: string[] = [];
  if (byName.has(rootName)) {
    reachable.add(rootName);
    queue.push(rootName);
  }
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const name of byName.get(current)?.imports ?? []) {
      if (!byName.has(name) || reachable.has(name)) continue;
      reachable.add(name);
      queue.push(name);
    }
  }
  return reachable;
}

/**
 * Modules that exist but are not reachable from `rootName`.
 *
 * @throws if `rootName` names no module, or if `allowlist` names a module that
 * no longer exists or is in fact reachable — a stale allowlist entry is how a
 * check like this quietly stops checking.
 */
export function findOrphanModules(
  nodes: readonly ModuleNode[],
  rootName: string,
  allowlist: readonly string[] = [],
): Orphan[] {
  if (!nodes.some((node) => node.name === rootName)) {
    throw new Error(
      `Root module ${rootName} was not found in the scanned source tree. ` +
        'Either it was renamed or the scan directory is wrong.',
    );
  }

  const reachable = reachableFrom(nodes, rootName);
  const allowed = new Set(allowlist);
  for (const name of allowed) {
    if (!nodes.some((node) => node.name === name)) {
      throw new Error(
        `Stale module-graph allowlist entry: ${name} no longer exists. Remove it from the allowlist.`,
      );
    }
    if (reachable.has(name)) {
      throw new Error(
        `Stale module-graph allowlist entry: ${name} is now reachable from ${rootName}. ` +
          'Remove it from the allowlist so it is checked like every other module.',
      );
    }
  }

  return nodes
    .filter((node) => !reachable.has(node.name) && !allowed.has(node.name))
    .map((node) => ({
      name: node.name,
      file: node.file,
      importedByUnreachable: nodes
        .filter(
          (other) =>
            other.name !== node.name && other.imports.includes(node.name),
        )
        .map((other) => other.name)
        .sort(),
    }));
}

/** A failure message that names the offending modules and says what to do. */
export function formatOrphanFailure(
  orphans: readonly Orphan[],
  rootName: string,
): string {
  const lines = [
    `${orphans.length} NestJS module(s) are not reachable from ${rootName}.`,
    'Nest never instantiates them, so every route, provider, processor and',
    'lifecycle hook they declare is dead at runtime (routes return 404) even',
    'though the app boots and the build passes.',
    '',
  ];
  for (const orphan of orphans) {
    lines.push(`  ${orphan.name}  (${orphan.file})`);
    if (orphan.importedByUnreachable.length === 0) {
      lines.push(
        `    Nothing imports it. Add ${orphan.name} to ${rootName}'s \`imports\` array`,
        '    (apps/api/src/app.module.ts) and export it from apps/api/src/modules/index.ts.',
      );
    } else {
      lines.push(
        `    Imported only by: ${orphan.importedByUnreachable.join(', ')} — which is/are`,
        `    themselves unreachable, so registering ${orphan.name} there changes nothing.`,
        '    Fix the importer first, or register this module directly on ' +
          `${rootName}.`,
      );
    }
    lines.push('');
  }
  lines.push(
    'If a module is genuinely meant to live outside the graph, add it to',
    'MODULE_GRAPH_ALLOWLIST in apps/api/src/module-graph.spec.ts with a comment',
    'saying why — do not loosen this assertion.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS, SEPARATELY FROM REACHABILITY
// ---------------------------------------------
// Reachability and acyclicity are different properties, and the check above
// only had the first. On 2026-09-22 `apps/api` could not start at all:
//
//   UndefinedModuleException: Nest cannot create the OnboardingModule instance.
//   The module at index [0] of the OnboardingModule "imports" array is undefined.
//   Scope [AppModule -> ObservabilityModule -> AlertingModule ->
//          AgentConfigModule -> AgentModule -> ToolExecutionModule ->
//          OrderModule -> StoreModule -> CustomerModule -> AuditModule]
//
// `2cf5d85` (Phase 7 / F25) had added `ToolExecutionModule -> OrderModule` and
// `OrderModule -> StoreModule`, closing a ring back through
// `AuditModule -> OnboardingModule` — an edge that had existed for months and
// was, at the time it was written, genuinely acyclic. Nothing caught it: the
// build passed, all 3090 unit specs passed, and THIS FILE's reachability
// assertion passed, because every module on the ring is perfectly reachable.
// A cycle is the one module-graph defect that reachability cannot see.
//
// (A second ring, `AlertingModule -> ... -> OrderModule ->
// NotificationsModule -> AlertingModule`, was hiding behind the first.)
//
// FORWARD REFS ARE NOT VIOLATIONS
// -------------------------------
// `forwardRef(() => X)` is Nest's supported way to declare a cycle on purpose;
// Nest resolves those instead of refusing to build the container. So this is
// not a blanket ban on cycles — it reports only rings on which EVERY edge is a
// plain import, which is exactly the set Nest cannot resolve. Breaking a ring
// with a `forwardRef` is therefore a legitimate fix, and one this check will
// accept. It is just rarely the right one: the cycle usually means a low-level
// module is reaching back up the graph for one provider, and extracting that
// provider into a leaf (see `onboarding/ports/tenant-auth-provisioning.module.ts`)
// removes the hazard instead of annotating it.

/**
 * Rings of plain (non-`forwardRef`) `imports` edges.
 *
 * Found by depth-first search over back edges, so every reported cycle is a
 * real path in the graph. It is not an enumeration of every elementary cycle —
 * that is exponential and, for a failure message, noise: one concrete path per
 * back edge is what someone needs to see which edge to cut. Deterministic for
 * a given graph, since nodes and edges are walked in the order they are given.
 *
 * A module that imports itself is reported as the one-edge cycle `[A, A]`.
 *
 * @param roots optional starting points. Defaults to every node, so a cycle is
 * found whether or not it is reachable from `AppModule`.
 */
export function findModuleCycles(
  nodes: readonly ModuleNode[],
  roots?: readonly string[],
): ModuleCycle[] {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const cycles: ModuleCycle[] = [];
  const reported = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const hardEdges = (name: string): string[] => {
    const node = byName.get(name);
    if (!node) return [];
    const deferred = new Set(node.forwardRefImports ?? []);
    return node.imports.filter(
      (target) => byName.has(target) && !deferred.has(target),
    );
  };

  const walk = (name: string): void => {
    state.set(name, 'visiting');
    stack.push(name);
    for (const target of hardEdges(name)) {
      if (state.get(target) === 'visiting') {
        const path = [...stack.slice(stack.lastIndexOf(target)), target];
        // One report per back edge: the same edge reached by two different
        // outer paths is one defect with one fix.
        const key = `${name} -> ${target}`;
        if (!reported.has(key)) {
          reported.add(key);
          cycles.push({
            path,
            edges: path
              .slice(0, -1)
              .map((from, index) => ({ from, to: path[index + 1] })),
          });
        }
      } else if (!state.has(target)) {
        walk(target);
      }
    }
    stack.pop();
    state.set(name, 'done');
  };

  for (const name of roots ?? nodes.map((node) => node.name)) {
    if (byName.has(name) && !state.has(name)) walk(name);
  }
  return cycles;
}

/**
 * A failure message shaped like the Nest trace the cycle would have produced,
 * so the CI failure and the boot failure are recognisably the same thing.
 */
export function formatCycleFailure(cycles: readonly ModuleCycle[]): string {
  const lines = [
    `${cycles.length} circular NestJS module import(s) with no forwardRef.`,
    'Nest cannot build a container with one of these: at boot it throws',
    'UndefinedModuleException ("the module at index [n] ... is undefined") and',
    'the app does not start — while `nest build` and every unit spec still pass.',
    '',
  ];
  for (const cycle of cycles) {
    lines.push(`  Scope [${cycle.path.join(' -> ')}]`);
    lines.push(
      `    Closed by: ${cycle.edges[cycle.edges.length - 1].from} imports ` +
        `${cycle.edges[cycle.edges.length - 1].to}.`,
      '',
    );
  }
  lines.push(
    'Cut one edge. Preferred: the edge where a low-level module imports a',
    'high-level one for a single provider — extract that provider into a leaf',
    'module (see modules/onboarding/ports/tenant-auth-provisioning.module.ts)',
    'and import the leaf instead. Last resort: forwardRef(() => X), which this',
    'check accepts but which leaves the coupling in place.',
  );
  return lines.join('\n');
}
