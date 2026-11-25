import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceFileFacts } from './scan.js';
import type { WorkspaceInfo } from './workspace.js';

/** Runtime dependencies nothing in the repository uses, and the file that declares them. */
export interface UnusedDependencies {
  /** `package.json`, as a report path. */
  file: string;
  /** Sorted. */
  packages: string[];
}

/**
 * Packages a project needs without importing them: Angular's own, which the
 * compiler and the CLI load, `tslib` (compiled helpers), `zone.js` (a
 * polyfill) and type packages.
 */
function isImplicit(name: string): boolean {
  return name.startsWith('@angular/') || name.startsWith('@types/') || name === 'tslib' || name === 'zone.js';
}

/**
 * Root files that name packages: config files tools read (`tailwind.config.js`,
 * `karma.conf.js`, `.eslintrc.json`, `proxy.conf.json`), `tsconfig*.json`,
 * whose `paths` can alias a package, and scripts (`patch.js`, `build.mjs`).
 */
const CONFIG_FILE = /^(?:\.[\w.-]+rc(?:\.(?:json|js|cjs|mjs|ya?ml))?|[\w.-]+\.(?:config|conf)\.(?:js|cjs|mjs|ts|mts|json)|tsconfig[\w.-]*\.json|[\w.-]+\.(?:js|cjs|mjs))$/;

/**
 * Where a Capacitor project's native side names the plugins it links: they
 * work without an import (the keyboard plugin resizes the view by itself).
 */
const NATIVE_FILES = ['android/capacitor.settings.gradle', 'android/app/capacitor.build.gradle', 'android/app/src/main/assets/capacitor.plugins.json', 'ios/App/Podfile', 'ios/App/CapApp-SPM/Package.swift'];

const CAPACITOR_CONFIG = ['capacitor.config.ts', 'capacitor.config.json', 'capacitor.config.js'];

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The packages other packages declare as peers: `@angular/cdk` for Material,
 * `chart.js` for ng2-charts. The project lists them so the peer is met, not
 * to import them. From `node_modules`, else from `package-lock.json`, which
 * records each package's peers. Undefined when neither is there to read, and
 * then the check says nothing rather than call a peer unused.
 */
function peersOf(root: string, declared: string[]): Set<string> | undefined {
  const peers = new Set<string>();
  const collect = (record: Record<string, unknown> | undefined): void => {
    const value = record?.['peerDependencies'];
    if (typeof value === 'object' && value !== null) for (const name of Object.keys(value)) peers.add(name);
  };
  if (existsSync(join(root, 'node_modules'))) {
    for (const name of declared) collect(readJson(join(root, 'node_modules', name, 'package.json')));
    return peers;
  }
  const lock = readJson(join(root, 'package-lock.json'));
  const packages = lock?.['packages'];
  if (typeof packages !== 'object' || packages === null) return undefined;
  for (const [key, entry] of Object.entries(packages as Record<string, Record<string, unknown>>)) if (key.startsWith('node_modules/')) collect(entry);
  return peers;
}

/**
 * Runtime dependencies (`dependencies`, not `devDependencies`) nothing uses:
 * no file imports or requires them, and neither `angular.json`, a
 * `project.json`, a stylesheet (`@use`, `@import`), an HTML file, a
 * `package.json` script, a root config, tsconfig or script file, the
 * `cordova` section of `package.json` nor a native Capacitor file names them.
 * Angular's own packages, `tslib`, `zone.js`, `@types/*`, the peers of other
 * packages and, in a Capacitor project, its `@capacitor/` packages are left
 * out. What only loads by a name built at runtime cannot be seen,
 * so the finding says to check before removing.
 *
 * @param texts Every stylesheet, HTML and JavaScript file the walk found, as absolute paths.
 * @returns Undefined without a `package.json`, or when the peers cannot be read.
 */
export function readUnusedDependencies(workspace: WorkspaceInfo, sources: SourceFileFacts[], texts: string[]): UnusedDependencies | undefined {
  const root = workspace.root;
  const packageJson = readJson(join(root, 'package.json'));
  if (!packageJson) return undefined;
  const production = Object.keys((packageJson['dependencies'] as Record<string, unknown> | undefined) ?? {});
  const development = Object.keys((packageJson['devDependencies'] as Record<string, unknown> | undefined) ?? {});
  const peers = peersOf(root, [...production, ...development]);
  if (!peers) return undefined;
  // In a Capacitor project its own packages are the platforms and the native plugins `cap sync` links.
  const capacitor = CAPACITOR_CONFIG.some((name) => existsSync(join(root, name)));
  let candidates = production.filter((name) => !isImplicit(name) && !peers.has(name) && !(capacitor && name.startsWith('@capacitor/')));
  if (candidates.length === 0) return { file: report(workspace, 'package.json'), packages: [] };

  const imported = (name: string): boolean => sources.some((file) => file.imports.some((fact) => fact.specifier === name || fact.specifier.startsWith(`${name}/`) || fact.specifier.endsWith(`/node_modules/${name}`) || fact.specifier.includes(`/node_modules/${name}/`)));
  candidates = candidates.filter((name) => !imported(name));

  const named = [
    JSON.stringify(packageJson['scripts'] ?? {}),
    // A Cordova project lists its plugins here.
    JSON.stringify(packageJson['cordova'] ?? {}),
    ...NATIVE_FILES.map((name) => readText(join(root, name))),
    readText(join(root, 'angular.json')),
    ...workspace.targets.map((target) => JSON.stringify({ options: target.options, configurations: target.configurations })),
    ...readdirSafe(root).filter((name) => CONFIG_FILE.test(name)).map((name) => readText(join(root, name))),
    ...texts.map(readText),
  ];
  const mentions = (name: string): boolean => {
    const pattern = new RegExp(`(?:^|[\\s'"\`(~/])${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?:['"\`/)\\s]|$)`, 'm');
    return named.some((text) => pattern.test(text));
  };
  return { file: report(workspace, 'package.json'), packages: candidates.filter((name) => !mentions(name)).sort() };
}

function readdirSafe(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function report(workspace: WorkspaceInfo, name: string): string {
  return workspace.subfolder ? `${workspace.subfolder}/${name}` : name;
}
