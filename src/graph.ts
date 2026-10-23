import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import type { ImportFact, SourceFileFacts } from './scan.js';

/** A group of files that import each other in a loop, directly or through others. */
export interface DependencyTangle {
  /** Report paths of every file in the group, sorted. */
  files: string[];
  /**
   * One concrete loop through the group, first file repeated at the end
   * (`a.ts → b.ts → a.ts`), so a reader can see where to cut. A large group
   * holds many loops; this is the shortest one through its first file.
   */
  example: string[];
}

/**
 * Finds the import cycles among the analysed files.
 *
 * Counts groups (strongly connected components) rather than individual cycles.
 * Two files that import each other plus a third that closes a second loop
 * through them are one problem to untangle, while a cycle count would call it
 * two or more and grows combinatorially with the size of the group, which is
 * why tools that list every cycle report numbers nobody can act on.
 *
 * Only eager, value-level edges count: `import type` is erased at compile time
 * and `import()` loads later, so neither can produce the initialisation-order
 * crash a cycle is dangerous for. Spec files are left out because nothing
 * imports them.
 *
 * @param compilerOptions The repository's compiler options, for `paths`
 *   aliases. Module resolution itself is forced to `bundler`, which is how the
 *   Angular CLI resolves and which needs no file extensions.
 */
export function findTangles(files: SourceFileFacts[], compilerOptions: ts.CompilerOptions): DependencyTangle[] {
  return findTanglesIn(buildImportGraph(files, compilerOptions));
}

/** The eager import graph of the application files: absolute path to the absolute paths it imports. */
export interface ImportGraph {
  edges: Map<string, string[]>;
  byAbsolute: Map<string, SourceFileFacts>;
}

/**
 * Resolves every eager, value-level import between the analysed files (see
 * `findTangles` for what counts). Built once per run and shared by the cycle
 * search and the lazy-loading analysis.
 */
export function buildImportGraph(files: SourceFileFacts[], compilerOptions: ts.CompilerOptions): ImportGraph {
  const sources = files.filter((file) => !file.isSpec);
  const byAbsolute = new Map(sources.map((file) => [resolve(file.absolutePath), file]));
  const options: ts.CompilerOptions = { ...compilerOptions, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: false };
  const cache = ts.createModuleResolutionCache(process.cwd(), (name) => name, options);

  // Pass 1: where each eager import points, if it is an analysed file.
  const resolvedImports = new Map<string, Array<{ fact: ImportFact; target: string }>>();
  for (const file of sources) {
    const resolvedFacts: Array<{ fact: ImportFact; target: string }> = [];
    for (const fact of file.imports) {
      if (fact.typeOnly || fact.dynamic) continue;
      // Bare specifiers that are not path aliases resolve into node_modules and are dropped below;
      // skipping the obvious ones first saves most of the resolution work.
      if (!fact.specifier.startsWith('.') && !options.paths) continue;
      const resolved = ts.resolveModuleName(fact.specifier, file.absolutePath, options, ts.sys, cache).resolvedModule;
      if (!resolved || resolved.isExternalLibraryImport) continue;
      const target = resolve(resolved.resolvedFileName);
      if (byAbsolute.has(target)) resolvedFacts.push({ fact, target });
    }
    resolvedImports.set(resolve(file.absolutePath), resolvedFacts);
  }

  // Pass 2: the type-only names of each file, following re-exports, so an
  // import of a type through an `index.ts` barrel is recognised too.
  const typeNames = new Map<string, Set<string>>();
  const typeNamesOf = (path: string): Set<string> => {
    const known = typeNames.get(path);
    if (known) return known;
    const names = new Set(byAbsolute.get(path)?.typeExports ?? []);
    typeNames.set(path, names); // set before recursing, so a re-export cycle ends
    for (const { fact, target } of resolvedImports.get(path) ?? []) {
      if (!fact.reexport) continue;
      const targetTypes = typeNamesOf(target);
      if (fact.bindings.length === 0) for (const name of targetTypes) names.add(name);
      for (const binding of fact.bindings) if (targetTypes.has(binding.imported)) names.add(binding.exported ?? binding.imported);
    }
    return names;
  };

  // Pass 3: the edges. An import whose every name is a type in the target is
  // erased by TypeScript even without `import type`, so it is no edge: the
  // case that made a 123-file "cycle" out of a library's model types.
  const edges = new Map<string, string[]>();
  for (const [path, resolvedFacts] of resolvedImports) {
    const targets = new Set<string>();
    for (const { fact, target } of resolvedFacts) {
      const onlyTypes = fact.bindings.length > 0 && fact.bindings.every((binding) => binding.typeOnly || !binding.valueUsed || typeNamesOf(target).has(binding.imported));
      if (!onlyTypes) targets.add(target);
    }
    edges.set(path, [...targets]);
  }
  return { edges, byAbsolute };
}

/**
 * Report paths of the application files a spec imports, directly or through
 * a barrel's re-exports. The testing check counts such a file as having a
 * spec even when the spec is not its `x.spec.ts` neighbour: a store tested
 * from `store/products.spec.ts`, a utility covered by a shared spec. Type-only
 * imports count too, since a spec that imports a type alone is rare and
 * telling it apart is not worth the cost here.
 */
export function filesImportedBySpecs(files: SourceFileFacts[], compilerOptions: ts.CompilerOptions): Set<string> {
  const byAbsolute = new Map(files.filter((file) => !file.isSpec).map((file) => [resolve(file.absolutePath), file]));
  const options: ts.CompilerOptions = { ...compilerOptions, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: false };
  const cache = ts.createModuleResolutionCache(process.cwd(), (name) => name, options);
  const resolveFrom = (from: string, specifier: string): SourceFileFacts | undefined => {
    if (!specifier.startsWith('.') && !options.paths) return undefined;
    const resolved = ts.resolveModuleName(specifier, from, options, ts.sys, cache).resolvedModule;
    return resolved && !resolved.isExternalLibraryImport ? byAbsolute.get(resolve(resolved.resolvedFileName)) : undefined;
  };
  const covered = new Set<string>();
  const add = (file: SourceFileFacts, depth: number): void => {
    if (covered.has(file.path)) return;
    covered.add(file.path);
    // Through `export … from` chains (barrels), a few levels deep.
    if (depth >= 4) return;
    for (const fact of file.imports) {
      if (!fact.reexport) continue;
      const target = resolveFrom(file.absolutePath, fact.specifier);
      if (target) add(target, depth + 1);
    }
  };
  for (const spec of files.filter((file) => file.isSpec)) {
    for (const fact of spec.imports) {
      const target = resolveFrom(spec.absolutePath, fact.specifier);
      if (target) add(target, 0);
    }
  }
  return covered;
}

/**
 * Report paths of the files the browser loads up front: everything reachable
 * from `entries` through static imports. A file reached only through
 * `import()` (a `loadChildren` or `loadComponent` target and what it imports)
 * is not in it. Entries that are not analysed files are ignored.
 */
export function staticallyReachable(graph: ImportGraph, entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entries.map((entry) => resolve(entry)).filter((entry) => graph.byAbsolute.has(entry));
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(graph.edges.get(next) ?? []));
  }
  return new Set([...seen].map((path) => graph.byAbsolute.get(path)!.path));
}

/** The cycle groups of an already built graph, largest first. */
export function findTanglesIn({ edges, byAbsolute }: ImportGraph): DependencyTangle[] {
  return stronglyConnectedComponents(edges)
    .filter((component) => component.length > 1 || (edges.get(component[0]!) ?? []).includes(component[0]!))
    .map((component) => {
      const members = new Set(component);
      const sorted = component.map((path) => byAbsolute.get(path)!.path).sort();
      const start = component.find((path) => byAbsolute.get(path)!.path === sorted[0])!;
      return { files: sorted, example: shortestLoop(start, edges, members).map((path) => byAbsolute.get(path)!.path) };
    })
    .sort((left, right) => right.files.length - left.files.length || left.files[0]!.localeCompare(right.files[0]!));
}

/**
 * Tarjan's algorithm, written iteratively. The recursive textbook version
 * overflows the stack on a long import chain, and a 3 000-file app has those.
 */
export function stronglyConnectedComponents(edges: Map<string, string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  for (const start of edges.keys()) {
    if (index.has(start)) continue;
    const work: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    index.set(start, counter);
    lowLink.set(start, counter++);
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const successors = edges.get(frame.node) ?? [];
      if (frame.next < successors.length) {
        const successor = successors[frame.next++]!;
        if (!index.has(successor)) {
          index.set(successor, counter);
          lowLink.set(successor, counter++);
          stack.push(successor);
          onStack.add(successor);
          work.push({ node: successor, next: 0 });
        } else if (onStack.has(successor)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node)!, index.get(successor)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) lowLink.set(parent.node, Math.min(lowLink.get(parent.node)!, lowLink.get(frame.node)!));
      if (lowLink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * The shortest path from `start` back to itself inside one component, by
 * breadth-first search. Always finds one, since every node of a strongly
 * connected component lies on a loop.
 */
function shortestLoop(start: string, edges: Map<string, string[]>, members: Set<string>): string[] {
  const previous = new Map<string, string>();
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    for (const successor of edges.get(node) ?? []) {
      if (!members.has(successor)) continue;
      if (successor === start) {
        // Walk back from the node that closes the loop; a self-import leaves the chain empty.
        const chain: string[] = [];
        for (let step: string | undefined = node; step !== undefined && step !== start; step = previous.get(step)) chain.unshift(step);
        return [start, ...chain, start];
      }
      if (!previous.has(successor) && successor !== start) {
        previous.set(successor, node);
        queue.push(successor);
      }
    }
  }
  return [start, start];
}

/**
 * Compiler options from the repository's root tsconfig, `extends` included,
 * which is where Nx and many CLI workspaces keep their `paths` aliases.
 * Returns empty options when there is no tsconfig or it cannot be parsed; the
 * graph then still resolves every relative import.
 */
export function readCompilerOptions(tsconfigPath: string | undefined): ts.CompilerOptions {
  if (!tsconfigPath) return {};
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error) return {};
  return ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(tsconfigPath), undefined, tsconfigPath).options;
}
