import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import type { SourceFileFacts, TemplateFact } from './scan.js';
import { asRecord, owningProject, readJson, type ProjectInfo, type WorkspaceInfo } from './workspace.js';

/**
 * Entry files recognised by name: what the CLI, Nx and the test runners load
 * from configuration rather than through an import. Matched on the file name
 * so a workspace that names them in a builder option this does not read
 * (a custom builder, a Jest preset) is still not reported.
 */
const ENTRY_NAME = /(^|\/)(main(\.[\w-]+)?|polyfills|test|test-setup|setup-jest|environment(\.[\w-]+)?|public[-_]api)\.ts$/;

/** Tooling that lives next to the code but is no application code: configs, stories, e2e page objects and suites. */
const TOOLING = /(\.(config|conf|stories|po|e2e-spec|cy)\.ts$)|((^|\/)(e2e|cypress|playwright|\.storybook)\/)/;

/**
 * Report paths of the application files nothing imports, sorted: no other
 * file imports them in any way (a value or a type, eagerly, through
 * `import()`, from a spec, through `new URL(..., import.meta.url)`, or as an
 * Angular 7 string `loadChildren`), no build target or tsconfig names them,
 * and no tsconfig `paths` alias points at them. The build never includes
 * such a file, so deleting it changes nothing at runtime.
 *
 * Deliberately one level deep: a file imported only by another unused file
 * is not reported, since telling it apart needs every entry point to be
 * known, and a wrong entry list would make whole folders look dead. Deleting
 * the reported files is safe and the next run shows the next layer.
 *
 * Only files inside the `sourceRoot` of a project that uses Angular are
 * candidates, so root-level scripts, tool configs and the React or e2e
 * projects of an Nx workspace are never reported.
 *
 * @returns Undefined for a repository that declares no projects (no
 *   `angular.json`, no `project.json`), where there is no source root to
 *   scope the search to and the measure would be noise.
 */
export function unimportedFiles(files: SourceFileFacts[], compilerOptions: ts.CompilerOptions, workspace: WorkspaceInfo): string[] | undefined {
  if (workspace.projects.length === 0) return undefined;
  const angularProjects = new Set<ProjectInfo>();
  for (const file of files) {
    const owner = owningProject(file.path, workspace.projects);
    if (owner && file.imports.some((fact) => fact.specifier.startsWith('@angular/'))) angularProjects.add(owner);
  }
  const inScope = (path: string): boolean => {
    const owner = owningProject(path, workspace.projects);
    if (!owner || !angularProjects.has(owner)) return false;
    const sourceRoot = owner.sourceRoot ?? owner.root;
    return sourceRoot === '' || path.startsWith(`${sourceRoot}/`);
  };

  const used = usedFiles(files, compilerOptions);
  for (const path of configuredEntries(workspace)) used.absolute.add(path);
  return files
    .filter((file) => !file.isSpec && !file.isGenerated && !file.path.endsWith('.d.ts') && !ENTRY_NAME.test(file.path) && !TOOLING.test(file.path))
    .filter((file) => inScope(file.path))
    .filter((file) => !used.absolute.has(resolve(file.absolutePath)) && !used.suffixes.some((suffix) => file.path.endsWith(suffix)))
    .map((file) => file.path)
    .sort();
}

/**
 * Absolute paths of every analysed file some import resolves to, and the
 * path endings of imports that resolve to nothing.
 *
 * Every specifier is resolved, bare ones included, unlike the cycle graph:
 * `'src/app/utils/x'` through `baseUrl`, and an Nx workspace package
 * (`@org/shared/state`) that resolves through a `node_modules` symlink into
 * `libs/`, both import a file of the repository. A target counts when it is
 * one of the analysed files, whatever module resolution calls it.
 *
 * An Angular 7 `loadChildren: 'app/admin/admin.module#AdminModule'` is
 * resolved by the old CLI against the source root, which module resolution
 * does not know, so such a file counts as used when its path ends in the
 * string.
 */
function usedFiles(files: SourceFileFacts[], compilerOptions: ts.CompilerOptions): { absolute: Set<string>; suffixes: string[] } {
  const options: ts.CompilerOptions = { ...compilerOptions, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: false };
  const cache = ts.createModuleResolutionCache(process.cwd(), (name) => name, options);
  const analysed = new Set(files.map((file) => resolve(file.absolutePath)));
  const absolute = new Set<string>();
  const suffixes: string[] = [];
  for (const file of files) {
    for (const fact of file.imports) {
      const resolved = ts.resolveModuleName(fact.specifier, file.absolutePath, options, ts.sys, cache).resolvedModule;
      const target = resolved && resolve(resolved.resolvedFileName);
      if (target && analysed.has(target)) absolute.add(target);
      else if (!resolved && fact.dynamic && !fact.specifier.startsWith('@')) suffixes.push(`${fact.specifier.replace(/^(\.\.?\/)+/, '').replace(/\.ts$/, '')}.ts`);
    }
  }
  return { absolute, suffixes };
}

/**
 * Absolute paths of the files the configuration names: every `.ts` string in
 * a build target's options and configurations (`browser`, `main`, `server`,
 * `ssr.entry`, `polyfills`, `fileReplacements`, a test `main`), the `files`
 * of each project's tsconfigs, each library's `ng-package.json` entry and
 * `package.json` entry points, and the targets of the root tsconfig's
 * `paths` (an Nx library's `index.ts`). The root `package.json` is left out:
 * its `main` is the application's server or nothing.
 */
function configuredEntries(workspace: WorkspaceInfo): Set<string> {
  const entries = new Set<string>();
  const collect = (value: unknown, base: string): void => {
    if (typeof value === 'string') {
      if (value.endsWith('.ts')) entries.add(resolve(base, value));
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item, base);
    } else if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) collect(item, base);
    }
  };
  for (const target of workspace.targets) {
    collect(target.options, target.baseDirectory);
    collect(target.configurations, target.baseDirectory);
  }
  const analysedRoot = workspace.subfolder ? resolve(workspace.root, ...workspace.subfolder.split('/').map(() => '..')) : workspace.root;
  for (const project of workspace.projects) {
    const projectDirectory = join(analysedRoot, project.root);
    for (const name of ['tsconfig.app.json', 'tsconfig.lib.json', 'tsconfig.spec.json', 'tsconfig.json']) {
      const tsconfig = join(projectDirectory, name);
      collect(readJson(tsconfig)?.['files'], dirname(tsconfig));
    }
    if (project.tsconfig) collect(readJson(project.tsconfig)?.['files'], dirname(project.tsconfig));
    // A workspace package's entry points (`exports`, `main`, `types`), which an Nx library resolves through instead of `paths`.
    const packageJson = join(projectDirectory, 'package.json');
    if (project.root !== '') {
      const manifest = readJson(packageJson);
      collect([manifest?.['exports'], manifest?.['main'], manifest?.['module'], manifest?.['types']], projectDirectory);
    }
    const entryFile = asRecord(readJson(join(projectDirectory, 'ng-package.json'))?.['lib'])['entryFile'];
    if (typeof entryFile === 'string') entries.add(resolve(projectDirectory, entryFile));
  }
  const rootTsconfig = workspace.rootTsconfig;
  const compilerOptions = asRecord(rootTsconfig ? readJson(rootTsconfig)?.['compilerOptions'] : undefined);
  if (rootTsconfig) {
    const baseUrl = typeof compilerOptions['baseUrl'] === 'string' ? resolve(dirname(rootTsconfig), compilerOptions['baseUrl']) : dirname(rootTsconfig);
    for (const targets of Object.values(asRecord(compilerOptions['paths']))) {
      if (!Array.isArray(targets)) continue;
      for (const target of targets) if (typeof target === 'string' && !target.includes('*')) entries.add(resolve(baseUrl, target));
    }
  }
  return entries;
}

/** A component, directive or pipe that nothing uses (see `unusedDeclarables`). */
export interface UnusedDeclarable {
  kind: 'component' | 'directive' | 'pipe';
  /** The class name. */
  name: string;
  path: string;
  line: number;
  /**
   * True for a directive, or a component whose selector names an attribute:
   * judged only with `--attribute-selectors`, and counted under a measure
   * of its own.
   */
  attributeSelector?: boolean;
}

/** One comma-separated part of a selector a template text can settle: a tag, attributes, or both (`app-hero`, `[appTooltip]`, `button[mat-button]`). */
interface SelectorPart {
  element?: string;
  attributes: string[];
}

/**
 * The parts of a selector, lower-cased, or undefined when any part is one a
 * template text cannot settle: a class (`.card`), a `:not(...)`, a
 * descendant combinator, or nothing at all. One such part makes the whole
 * declarable unjudgeable, since that part might be the one that matches.
 */
export function parseSelector(selector: string | undefined): SelectorPart[] | undefined {
  if (selector === undefined) return undefined;
  const parts: SelectorPart[] = [];
  for (const raw of selector.split(',')) {
    const part = raw.trim();
    const match = /^([a-zA-Z][\w-]*)?((?:\[[^\]=\s]+(?:=[^\]]*)?\])*)$/.exec(part);
    if (!match || part === '') return undefined;
    const attributes = [...match[2]!.matchAll(/\[([^\]=\s]+)/g)].map((attribute) => attribute[1]!.toLowerCase());
    parts.push({ ...(match[1] ? { element: match[1].toLowerCase() } : {}), attributes });
  }
  return parts;
}

/**
 * Components, directives and pipes no template uses and no file mentions,
 * in path order.
 *
 * A component or directive is used when a template of the repository
 * (`index.html` included, which is where `<app-root>` is) has what one part
 * of its selector asks for: the tag, the attributes (`[appTooltip]` matches
 * `appTooltip`, `[appTooltip]="x"` and a structural `*appTooltip`), or both
 * (`button[mat-button]`), or when
 * any file, its own included, names its class outside the listing arrays of
 * Angular metadata (see `SourceFileFacts.classReferences`): a route, a
 * dialog, `createComponent`, `bootstrap`. A pipe is used when a template
 * calls it by name or a file names its class (`inject(DatePipe)`,
 * `providers`). Declaring a component in an NgModule, or listing it in a
 * standalone `imports` array, keeps nothing alive: Angular itself reports
 * such an import as unused.
 *
 * Directives, and components whose selector names an attribute, are judged
 * only with `attributeSelectors` (`--attribute-selectors`): an attribute is
 * looser evidence than a tag, since the tag and the attribute are not
 * checked to sit on the same element.
 *
 * Left out, because a template text cannot settle them: selectors with a
 * class or a `:not(...)` (see `parseSelector`), declarables without a
 * selector (host directives, abstract bases), default exports (routes load them by file), everything in a
 * library project (its consumers may live in other repositories), and the
 * files already listed by `unimportedFiles`, so nothing is reported twice.
 */
export function unusedDeclarables(files: SourceFileFacts[], templates: TemplateFact[], workspace: WorkspaceInfo, unimported: string[] | undefined, attributeSelectors: boolean): UnusedDeclarable[] | undefined {
  if (workspace.projects.length === 0 || unimported === undefined) return undefined;
  const elements = new Set(templates.flatMap((template) => template.usage.elements));
  const attributes = new Set(templates.flatMap((template) => template.usage.attributes));
  const pipes = new Set(templates.flatMap((template) => template.usage.pipes));
  // Whether the tag and the attributes appear on the same element is not checked, which can only call an unused selector used, never the reverse.
  const matched = (parts: SelectorPart[]): boolean => parts.some((part) => (part.element === undefined || elements.has(part.element)) && part.attributes.every((attribute) => attributes.has(attribute)));
  // Its own file counts too: `exposeComponent(FlightWidget, ...)` or a `forwardRef(() => X)` next to the class is a use the analysis cannot rule out.
  const referenced = new Set(files.filter((file) => !file.isSpec).flatMap((file) => file.classReferences));
  const skipped = new Set(unimported);
  const result: UnusedDeclarable[] = [];
  for (const file of files) {
    if (file.isSpec || file.isGenerated || skipped.has(file.path)) continue;
    const owner = owningProject(file.path, workspace.projects);
    if (!owner || owner.type === 'library') continue;
    for (const [kind, declarables] of [['component', file.components], ['directive', file.directives]] as const) {
      for (const declarable of declarables) {
        const parts = parseSelector(declarable.selector);
        if (declarable.defaultExport || !parts || matched(parts) || referenced.has(declarable.name)) continue;
        const byAttribute = kind === 'directive' || parts.some((part) => part.attributes.length > 0);
        if (byAttribute && !attributeSelectors) continue;
        result.push({ kind, name: declarable.name, path: file.path, line: declarable.line, ...(byAttribute ? { attributeSelector: true } : {}) });
      }
    }
    for (const pipe of file.pipes) {
      if (pipe.defaultExport || pipe.name === undefined) continue;
      if (pipes.has(pipe.name) || referenced.has(pipe.className)) continue;
      result.push({ kind: 'pipe', name: pipe.className, path: file.path, line: pipe.line });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

/** An input or output no template binds (see `unusedBindings`). */
export interface UnusedBinding {
  kind: 'input' | 'output';
  /** The name a template would bind: the alias when there is one. */
  name: string;
  /** The component or directive that declares it. */
  owner: string;
  path: string;
  line: number;
}

/**
 * Inputs and outputs of the used components and directives that no template
 * binds, in path order. Only with `--attribute-selectors`, since it rests
 * on the same attribute matching.
 *
 * Names are compared across the whole repository, not per element: an input
 * called `value` is used as soon as any template binds a `value`, whichever
 * component that template meant. That can only call an unused input used.
 * An input counts as bound by a plain attribute (`label="Save"`), a binding
 * (`[label]`), a two-way binding, or code that sets it by name
 * (`setInput('label', x)`, `inputBinding('label', ...)`); an output by an
 * event binding or `outputBinding`; a `model()` by either of its names.
 *
 * Left out: classes that are unused themselves (they are already listed),
 * classes in library projects, and every component input when some file
 * calls `withComponentInputBinding()` or sets `bindToComponentInputs`, since
 * the router then fills inputs from the URL by name, which no template shows.
 */
export function unusedBindings(files: SourceFileFacts[], templates: TemplateFact[], workspace: WorkspaceInfo, declarables: UnusedDeclarable[] | undefined, unimported: string[] | undefined): UnusedBinding[] | undefined {
  if (!declarables || !unimported) return undefined;
  const bound = new Set([...templates.flatMap((template) => template.usage.attributes), ...files.flatMap((file) => file.bindingNamesInCode.map((name) => name.toLowerCase()))]);
  const routerBindsInputs = files.some((file) => file.calls.has('@angular/router#withComponentInputBinding') || file.bindsRouteInputs === true);
  const dead = new Set([...unimported, ...declarables.map((entry) => `${entry.path}#${entry.name}`)]);
  const result: UnusedBinding[] = [];
  for (const file of files) {
    if (file.isSpec || file.isGenerated || dead.has(file.path)) continue;
    const owner = owningProject(file.path, workspace.projects);
    if (!owner || owner.type === 'library') continue;
    for (const [kind, classes] of [['component', file.components], ['directive', file.directives]] as const) {
      for (const declarable of classes) {
        if (dead.has(`${file.path}#${declarable.name}`)) continue;
        if (!(kind === 'component' && routerBindsInputs)) {
          for (const input of declarable.inputs ?? []) {
            if (bound.has(input.name.toLowerCase()) || (input.alsoAs !== undefined && bound.has(input.alsoAs.toLowerCase()))) continue;
            result.push({ kind: 'input', name: input.name, owner: declarable.name, path: file.path, line: input.line });
          }
        }
        for (const output of declarable.outputs ?? []) {
          if (bound.has(output.name.toLowerCase())) continue;
          result.push({ kind: 'output', name: output.name, owner: declarable.name, path: file.path, line: output.line });
        }
      }
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}
