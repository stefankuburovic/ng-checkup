import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { readLockedVersions } from './lockfile.js';
import type { WorkspaceKind } from './types.js';

/** One build/test/e2e target of one project, as `angular.json` or a `project.json` declares it. */
export interface TargetInfo {
  project: string;
  target: string;
  /** The `builder` (Angular CLI) or `executor` (Nx), such as `@angular/build:application`. */
  builder: string;
  /** The target's `options` block, untyped because every builder defines its own. */
  options: Record<string, unknown>;
  /** The target's `configurations` block (`production`, `development`), untyped like `options`. Read for the bundle budgets. */
  configurations?: Record<string, unknown>;
  /** Absolute directory the project's relative option paths resolve against. */
  baseDirectory: string;
}

/** One application or library of the workspace, from `angular.json` or its `project.json`. */
export interface ProjectInfo {
  name: string;
  /** Directory relative to the analysed root, `/`-separated; an empty string for a project at the root. */
  root: string;
  type: 'application' | 'library' | 'unknown';
  /**
   * The tsconfig the project is compiled with: its build target's `tsConfig`,
   * else `tsconfig.app.json`, `tsconfig.lib.json` or `tsconfig.json` in its
   * root. Undefined when none exists.
   */
  tsconfig?: string;
}

/** What the analysis knows about the repository before it reads any source file. */
export interface WorkspaceInfo {
  root: string;
  name: string;
  kind: WorkspaceKind;
  /** `dependencies` and `devDependencies` of the root `package.json`, merged. Empty when there is none. */
  dependencies: Record<string, string>;
  /** Whether `node_modules/@angular/core` exists, which the deprecation index needs. */
  hasNodeModules: boolean;
  /**
   * Exact versions of the dependencies and of `typescript`, `rxjs` and
   * `zone.js`: from `node_modules` when installed, else from the lockfile.
   * Absent for a package neither pins.
   */
  versions: Record<string, string>;
  angular: {
    /** The range `package.json` asks for, such as `^17.3.0`. */
    declared?: string;
    /** The exact version: installed in `node_modules`, else pinned by the lockfile. */
    installed?: string;
    /** Where `installed` came from, for the report. Undefined when neither has it. */
    source?: 'node_modules' | 'package-lock.json' | 'yarn.lock' | 'pnpm-lock.yaml';
    /** From `installed` when present, else from `declared`. Absent when Angular is not a dependency. */
    major?: number;
  };
  /**
   * The project's TypeScript major, installed version first, then the
   * `package.json` range. It decides what an absent `strict` means: on from
   * TypeScript 6, off before.
   */
  typescriptMajor?: number;
  targets: TargetInfo[];
  /**
   * Every project the workspace declares, in declaration order. Empty for a
   * repository with neither `angular.json` nor `project.json` files. A
   * single-project CLI workspace has one entry whose root is `''`.
   */
  projects: ProjectInfo[];
  /** Every polyfill entry of every target, which is where `zone.js` is wired in for CLI 15+ projects. */
  polyfills: string[];
  /** The tsconfig the application is compiled with, used for the strictness flags. */
  appTsconfig?: string;
  /** The tsconfig holding repository-wide `paths`, used to resolve imports for the dependency graph. */
  rootTsconfig?: string;
  /**
   * The folder, relative to the analysed root, the Angular workspace was read
   * from when it is not the root itself (see `resolveWorkspace`); `root` then
   * points there too. Absent for a workspace at the root.
   */
  subfolder?: string;
  /** Angular workspaces in subfolders, relative to the root, when there are several and none at the root. */
  nestedWorkspaces?: string[];
}

/**
 * The workspace to analyse: the root's, or the one Angular workspace in a
 * subfolder when the root is none.
 *
 * Repositories that are not JavaScript projects at heart keep their Angular
 * app in a folder of its own: privacyIDEA, a Python server, has its web UI in
 * `privacyidea/static` with its own `angular.json` and `package.json`. Read
 * from the root, such a repository had no Angular version, no tsconfig and no
 * build targets, so half the checks graded `info` and the routes all looked
 * eager. When the root has no `angular.json`, no Nx workspace and no
 * `@angular/core`, and exactly one subfolder has an `angular.json`, that
 * folder becomes the workspace: its package.json, lockfile, node_modules,
 * tsconfig and targets, with project roots made relative to the analysed
 * root again. Every file of the repository is still scanned. Dependencies of
 * the root's `package.json` that the subfolder does not declare are kept,
 * so an AngularJS app at the root still has its `angular` version.
 *
 * With several such subfolders nothing is chosen; `nestedWorkspaces` lists
 * them so the report can say which to run on.
 */
export function resolveWorkspace(root: string, projectJsons: string[], nestedAngularJsons: string[]): WorkspaceInfo {
  const atRoot = readWorkspace(root, projectJsons);
  if (atRoot.kind !== 'unknown' || atRoot.angular.major !== undefined || nestedAngularJsons.length === 0) return atRoot;
  const folders = nestedAngularJsons.map((path) => dirname(path));
  if (folders.length > 1) return { ...atRoot, nestedWorkspaces: folders.map((folder) => relative(root, folder).split(/[\\/]/).join('/')) };
  const folder = folders[0]!;
  const prefix = relative(root, folder).split(/[\\/]/).join('/');
  const inner = readWorkspace(folder, []);
  return {
    ...inner,
    dependencies: { ...atRoot.dependencies, ...inner.dependencies },
    versions: { ...atRoot.versions, ...inner.versions },
    projects: inner.projects.map((project) => ({ ...project, root: project.root ? `${prefix}/${project.root}` : prefix })),
    subfolder: prefix,
  };
}

/**
 * Reads the repository-level configuration: `package.json`, `angular.json` or
 * the Nx `project.json` files, and the tsconfig files that matter.
 *
 * Every read is defensive. A repository is analysed as far as it can be, so a
 * missing or malformed file leaves the corresponding field empty instead of
 * aborting the run; the checks that depend on it then grade `info`.
 *
 * @param projectJsons The `project.json` paths the file walk already found, so
 *   an Nx workspace is not walked a second time.
 */
export function readWorkspace(root: string, projectJsons: string[]): WorkspaceInfo {
  const packageJson = readJson(join(root, 'package.json'));
  const dependencies: Record<string, string> = {
    ...asStringRecord(packageJson?.['devDependencies']),
    ...asStringRecord(packageJson?.['dependencies']),
  };
  const angularJson = readJson(join(root, 'angular.json'));
  const isNx = existsSync(join(root, 'nx.json'));
  const kind: WorkspaceKind = angularJson ? 'angular-cli' : isNx ? 'nx' : 'unknown';

  const targets = angularJson ? readAngularJsonTargets(root, angularJson) : readProjectJsonTargets(projectJsons);
  const projects = angularJson ? readAngularJsonProjects(root, angularJson, targets) : readProjectJsonProjects(root, projectJsons, targets);
  const installedCore = readInstalledVersion(root, '@angular/core');
  const declared = dependencies['@angular/core'];
  // One lookup per dependency: node_modules first, the lockfile for the rest.
  const names = [...new Set([...Object.keys(dependencies), 'typescript', 'rxjs', 'zone.js'])];
  const locked = readLockedVersions(root, names, dependencies);
  const versions: Record<string, string> = {};
  for (const name of names) {
    const version = readInstalledVersion(root, name) ?? locked.versions[name];
    if (version) versions[name] = version;
  }
  const installed = versions['@angular/core'];
  const lockfileName = { npm: 'package-lock.json', yarn: 'yarn.lock', pnpm: 'pnpm-lock.yaml' } as const;
  const source = installedCore ? 'node_modules' : installed && locked.kind ? lockfileName[locked.kind] : undefined;

  return {
    root,
    name: typeof packageJson?.['name'] === 'string' ? packageJson['name'] : basename(root),
    kind,
    dependencies,
    hasNodeModules: installedCore !== undefined,
    versions,
    angular: { declared, installed, ...(source ? { source } : {}), major: majorOf(installed ?? declared) },
    typescriptMajor: majorOf(versions['typescript'] ?? dependencies['typescript']),
    targets,
    projects,
    polyfills: targets.flatMap((target) => polyfillsOf(target.options)),
    appTsconfig: findAppTsconfig(root, targets),
    rootTsconfig: ['tsconfig.base.json', 'tsconfig.json'].map((name) => join(root, name)).find((path) => existsSync(path)),
  };
}

/**
 * The major version in a version or a range: `^17.3.0` gives 17, `~22.0.8`
 * gives 22, `22.0.8` gives 22. Undefined for anything without a leading number,
 * such as `latest`, a git URL or a `workspace:` protocol.
 */
export function majorOf(versionOrRange: string | undefined): number | undefined {
  const match = versionOrRange?.match(/(\d+)\.\d+/) ?? versionOrRange?.match(/^[\^~>=<\s]*(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

/**
 * The `version` field of an installed package, or undefined when the package
 * is not in `node_modules`. Reads `package.json` directly instead of using
 * `require.resolve`, which would honour the analysed package's `exports` map
 * and refuse a path it does not export.
 */
export function readInstalledVersion(root: string, packageName: string): string | undefined {
  const version = readJson(join(root, 'node_modules', packageName, 'package.json'))?.['version'];
  return typeof version === 'string' ? version : undefined;
}

/**
 * Absolute paths of the application entry files: the `browser` option of
 * the application builder, or `main` of the older browser builders. These
 * are where the static import graph starts when telling eager code from lazy.
 */
export function applicationEntries(workspace: WorkspaceInfo): string[] {
  return workspace.targets
    .filter((target) => target.target === 'build')
    .map((target) => ({ target, entry: target.options['browser'] ?? target.options['main'] }))
    .filter((item): item is { target: TargetInfo; entry: string } => typeof item.entry === 'string')
    .map(({ target, entry }) => resolve(target.baseDirectory, entry));
}

/**
 * The workspace narrowed to one project, for `--project` and the
 * per-project breakdown: its own targets, polyfills and tsconfig, everything
 * read from the root `package.json` unchanged (an Nx workspace has one set of
 * dependencies for all projects).
 */
export function restrictToProject(workspace: WorkspaceInfo, project: ProjectInfo): WorkspaceInfo {
  const targets = workspace.targets.filter((target) => target.project === project.name);
  return {
    ...workspace,
    name: project.name,
    targets,
    projects: [project],
    polyfills: targets.flatMap((target) => polyfillsOf(target.options)),
    appTsconfig: project.tsconfig ?? workspace.appTsconfig,
  };
}

/**
 * The project a report path belongs to: the one with the longest root that
 * contains it, so a library nested inside an application's folder keeps its
 * own files. Undefined for a file outside every project (root-level scripts,
 * tooling), which then counts only towards the whole-workspace report.
 */
export function owningProject(path: string, projects: ProjectInfo[]): ProjectInfo | undefined {
  let owner: ProjectInfo | undefined;
  for (const project of projects) {
    const inside = project.root === '' || path === project.root || path.startsWith(`${project.root}/`);
    if (inside && (!owner || project.root.length > owner.root.length)) owner = project;
  }
  return owner;
}

/** Projects of `angular.json`, whose `root` is relative to the workspace (an empty string for the default app). */
function readAngularJsonProjects(root: string, angularJson: Record<string, unknown>, targets: TargetInfo[]): ProjectInfo[] {
  return Object.entries(asRecord(angularJson['projects'])).map(([name, value]) => {
    const project = asRecord(value);
    const projectRoot = typeof project['root'] === 'string' ? project['root'].replace(/\\/g, '/').replace(/\/+$/, '') : '';
    return { name, root: projectRoot, type: projectTypeOf(project['projectType']), tsconfig: projectTsconfig(root, projectRoot, name, targets, project['projectType']) };
  });
}

/** Projects of an Nx workspace: one per `project.json`, rooted at its directory. */
function readProjectJsonProjects(root: string, projectJsons: string[], targets: TargetInfo[]): ProjectInfo[] {
  const projects: ProjectInfo[] = [];
  for (const path of projectJsons) {
    const project = readJson(path);
    if (!project) continue;
    const name = typeof project['name'] === 'string' ? project['name'] : basename(dirname(path));
    const projectRoot = relative(root, dirname(path)).split('\\').join('/');
    projects.push({ name, root: projectRoot, type: projectTypeOf(project['projectType']), tsconfig: projectTsconfig(root, projectRoot, name, targets, project['projectType']) });
  }
  return projects;
}

/** `projectType` as declared; Nx infers it when absent, which this does not try to. */
function projectTypeOf(value: unknown): ProjectInfo['type'] {
  return value === 'application' || value === 'library' ? value : 'unknown';
}

/** See `ProjectInfo.tsconfig`. A library looks for `tsconfig.lib.json` before `tsconfig.app.json`. */
function projectTsconfig(root: string, projectRoot: string, name: string, targets: TargetInfo[], type: unknown): string | undefined {
  const build = targets.find((target) => target.project === name && target.target === 'build');
  const fromTarget = build?.options['tsConfig'];
  if (build && typeof fromTarget === 'string') {
    const path = resolve(build.baseDirectory, fromTarget);
    if (existsSync(path)) return path;
  }
  const names = type === 'library' ? ['tsconfig.lib.json', 'tsconfig.app.json', 'tsconfig.json'] : ['tsconfig.app.json', 'tsconfig.lib.json', 'tsconfig.json'];
  return names.map((file) => join(root, projectRoot, file)).find((path) => existsSync(path));
}

/** Targets from `angular.json`, which calls them `architect` in older files and `targets` in newer ones. */
function readAngularJsonTargets(root: string, angularJson: Record<string, unknown>): TargetInfo[] {
  const projects = asRecord(angularJson['projects']);
  const targets: TargetInfo[] = [];
  for (const [projectName, value] of Object.entries(projects)) {
    const project = asRecord(value);
    const projectRoot = typeof project['root'] === 'string' ? project['root'] : '';
    const declared = asRecord(project['architect'] ?? project['targets']);
    for (const [targetName, target] of Object.entries(declared)) {
      const builder = asRecord(target)['builder'];
      if (typeof builder !== 'string') continue;
      // angular.json resolves option paths against the workspace root, not the project root.
      targets.push({ project: projectName || projectRoot, target: targetName, builder, options: asRecord(asRecord(target)['options']), configurations: asRecord(asRecord(target)['configurations']), baseDirectory: root });
    }
  }
  return targets;
}

/** Targets from Nx `project.json` files, which name the builder `executor`. */
function readProjectJsonTargets(projectJsons: string[]): TargetInfo[] {
  const targets: TargetInfo[] = [];
  for (const path of projectJsons) {
    const project = readJson(path);
    if (!project) continue;
    const projectName = typeof project['name'] === 'string' ? project['name'] : basename(dirname(path));
    for (const [targetName, target] of Object.entries(asRecord(project['targets']))) {
      const record = asRecord(target);
      const builder = record['executor'] ?? record['builder'];
      if (typeof builder !== 'string') continue;
      // Nx resolves option paths against the workspace root as well, which is
      // two or more levels above the project.json in a typical apps/ layout.
      targets.push({ project: projectName, target: targetName, builder, options: asRecord(record['options']), configurations: asRecord(record['configurations']), baseDirectory: findWorkspaceRoot(path) });
    }
  }
  return targets;
}

/** The nearest ancestor of `path` holding `nx.json`, falling back to the file's own directory. */
function findWorkspaceRoot(path: string): string {
  let directory = dirname(path);
  while (true) {
    if (existsSync(join(directory, 'nx.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return dirname(path);
    directory = parent;
  }
}

/** `polyfills` is a string in CLI 15–16 projects and an array from CLI 17 on. */
function polyfillsOf(options: Record<string, unknown>): string[] {
  const polyfills = options['polyfills'];
  if (typeof polyfills === 'string') return [polyfills];
  return Array.isArray(polyfills) ? polyfills.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * The application's tsconfig: the `tsConfig` option of the first application
 * build target, then a root `tsconfig.app.json`, then the root `tsconfig.json`.
 *
 * A library's build target is skipped on purpose. Libraries are commonly built
 * with laxer settings than the app, and the app config is what decides how
 * strictly the shipped code is checked.
 */
function findAppTsconfig(root: string, targets: TargetInfo[]): string | undefined {
  const applicationBuild = targets.find((target) => target.target === 'build' && /:(application|browser|browser-esbuild|webpack-browser)$/.test(target.builder));
  const fromTarget = applicationBuild?.options['tsConfig'];
  if (applicationBuild && typeof fromTarget === 'string') {
    const path = resolve(applicationBuild.baseDirectory, fromTarget);
    if (existsSync(path)) return path;
  }
  return ['tsconfig.app.json', 'tsconfig.json'].map((name) => join(root, name)).find((path) => existsSync(path));
}

/**
 * Parses a JSON file that may contain comments and trailing commas, which
 * `angular.json`, `project.json` and every tsconfig are allowed to. Returns
 * undefined for a missing file, a parse error, or anything that is not an object.
 */
export function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
  if (parsed.error || typeof parsed.config !== 'object' || parsed.config === null) return undefined;
  return parsed.config as Record<string, unknown>;
}

/** Narrows an unknown JSON value to an object, treating anything else as empty. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Narrows a dependency map, dropping any entry whose version is not a string. */
function asStringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(asRecord(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
