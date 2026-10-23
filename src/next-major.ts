import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchPackument, inBatches, resolveVersion } from './compatibility.js';
import { buildApiIndexFrom, type ApiIndex, type DeprecationInfo } from './deprecations.js';
import { cacheDirectory, packageTypings } from './package-store.js';
import type { SourceFileFacts } from './scan.js';
import type { FileRef } from './types.js';
import type { WorkspaceInfo } from './workspace.js';

/** One imported API that the next major removes or deprecates, and where the code imports it. */
export interface ApiChange {
  /** The import path, such as `@angular/common/http`. */
  module: string;
  name: string;
  /** For a deprecation, what the tag says; for a removal, undefined. */
  info?: DeprecationInfo;
  /** One reference per file, at the import. */
  refs: FileRef[];
}

/** What the next Angular major changes for the APIs this code imports. `AnalysisContext.nextMajor`. */
export interface NextMajorChanges {
  major: number;
  /** The `@angular/core` version compared with: the last release of that major, or a prerelease. */
  version: string;
  /** True when the major is not released yet and `version` is the registry's `next` prerelease. */
  prerelease: boolean;
  /** Imported names the next major no longer exports: compile errors after `ng update`. Most files first. */
  removed: ApiChange[];
  /**
   * Imported names, and enum or static members of them (`ChangeDetectionStrategy.Default`),
   * that the next major deprecates and the current one does not. Most files first.
   */
  deprecated: ApiChange[];
  /** Imported packages whose typings for one of the two versions could not be had. */
  missing: string[];
}

/**
 * Compares the public API of the `@angular/*` and `@ngrx/*` packages this
 * code imports, at the installed version and at the next major, and keeps
 * the differences that touch an import: a name that is gone, and a name
 * that becomes deprecated.
 *
 * The deprecated-APIs check can only read the tags of the version that is
 * installed, so whatever the next major deprecates or deletes was invisible
 * until after `ng update`. This reads the next major's own `.d.ts` files the
 * same way, downloaded once into the typings cache, so the report can say
 * "these 3 imports stop compiling on 22" before anyone starts.
 *
 * A name counts as removed only when the installed version's typings export
 * it and the next major's do not. Comparing against the installed typings,
 * not against the import itself, keeps a name the reader cannot see in
 * either version (an unusual export form) from being reported as removed.
 *
 * When the project is on the latest major and the registry's `next` tag is a
 * prerelease of the one after, that prerelease is compared instead, so the
 * report shows what Angular 23 breaks while 23 is still in RC.
 *
 * @param latestMajor The newest released major, as the run knows it.
 * @returns Undefined when the Angular version is unknown, when there is no
 *   next major to compare with (none released and no prerelease, or
 *   offline with nothing cached), or when the code imports no Angular or
 *   NgRx package.
 */
export async function nextMajorChanges(workspace: WorkspaceInfo, sources: SourceFileFacts[], latestMajor: number, offline: boolean): Promise<NextMajorChanges | undefined> {
  const current = workspace.angular.major;
  if (current === undefined) return undefined;
  const target = current + 1;

  // Every import of an Angular or NgRx name, by module and name, one reference per file.
  const uses = new Map<string, ApiChange>();
  for (const file of sources) {
    for (const fact of file.imports) {
      if (fact.dynamic || !isTracked(fact.specifier)) continue;
      for (const binding of fact.bindings) {
        if (binding.imported === '*' || binding.imported === 'default' || binding.imported.startsWith('ɵ')) continue;
        const key = `${fact.specifier}#${binding.imported}`;
        const use = uses.get(key) ?? { module: fact.specifier, name: binding.imported, refs: [] };
        if (!use.refs.some((ref) => ref.path === file.path)) use.refs.push({ path: file.path, line: fact.line });
        uses.set(key, use);
      }
    }
  }
  // `ChangeDetectionStrategy.Default` and the like: members the scanner resolved through an import.
  const memberUses = new Map<string, ApiChange>();
  for (const file of sources) {
    for (const [key, lines] of file.memberAccesses) {
      const separator = key.indexOf('#');
      const module = key.slice(0, separator);
      if (!isTracked(module)) continue;
      const use = memberUses.get(key) ?? { module, name: key.slice(separator + 1), refs: [] };
      if (!use.refs.some((ref) => ref.path === file.path)) use.refs.push({ path: file.path, line: lines[0] });
      memberUses.set(key, use);
    }
  }
  if (uses.size === 0) return undefined;

  let prerelease: string | undefined;
  if (target > latestMajor) {
    if (offline) return undefined;
    const next = (await fetchPackument('@angular/core'))?.next;
    if (!next || majorOf(next) !== target) return undefined;
    prerelease = next;
  }

  const packages = [...new Set([...uses.values()].map((use) => packageName(use.module)))].sort();
  const currentDirectories: Array<[string, string]> = [];
  const targetDirectories: Array<[string, string]> = [];
  const missing: string[] = [];
  let coreVersion: string | undefined;
  await inBatches(packages, 4, async (name) => {
    const installed = join(workspace.root, 'node_modules', name);
    const currentVersion = workspace.versions[name] ?? (offline ? undefined : await resolveVersion(name, workspace.dependencies[name]));
    const currentDirectory = existsSync(join(installed, 'package.json')) ? installed : currentVersion ? await packageTypings(name, currentVersion, offline) : undefined;
    const targetVersion = await versionAt(name, target, prerelease !== undefined, offline);
    const targetDirectory = targetVersion ? await packageTypings(name, targetVersion, offline) : undefined;
    if (!currentDirectory || !targetDirectory) {
      missing.push(name);
      return;
    }
    if (name === '@angular/core') coreVersion = targetVersion;
    currentDirectories.push([name, currentDirectory]);
    targetDirectories.push([name, targetDirectory]);
  });
  if (targetDirectories.length === 0) return undefined;

  const before: ApiIndex = buildApiIndexFrom(currentDirectories);
  const after: ApiIndex = buildApiIndexFrom(targetDirectories);
  const compared = new Set(targetDirectories.map(([name]) => name));
  const removed: ApiChange[] = [];
  const deprecated: ApiChange[] = [];
  for (const use of uses.values()) {
    if (!compared.has(packageName(use.module))) continue;
    const was = before.get(use.module);
    const now = after.get(use.module);
    if (!was?.names.has(use.name)) continue;
    if (!now?.names.has(use.name)) {
      removed.push(use);
      continue;
    }
    const info = now.symbols.get(use.name);
    if (info && !was.symbols.has(use.name)) deprecated.push({ ...use, info });
  }
  // Members are only known when deprecated (the reader does not list every member), so a removed member cannot be told from an unread one and only deprecations count.
  for (const use of memberUses.values()) {
    if (!compared.has(packageName(use.module))) continue;
    const info = after.get(use.module)?.members.get(use.name);
    if (info && !before.get(use.module)?.members.has(use.name)) deprecated.push({ ...use, info });
  }
  const byFiles = (left: ApiChange, right: ApiChange): number => right.refs.length - left.refs.length || left.module.localeCompare(right.module) || left.name.localeCompare(right.name);
  return {
    major: target,
    version: coreVersion ?? prerelease ?? `${target}.x`,
    prerelease: prerelease !== undefined,
    removed: removed.sort(byFiles),
    deprecated: deprecated.sort(byFiles),
    missing: missing.sort(),
  };
}

/** Angular's and NgRx's packages: the ones whose majors follow Angular's, so "the next major" means the same thing for all of them. */
function isTracked(specifier: string): boolean {
  return specifier.startsWith('@angular/') || specifier.startsWith('@ngrx/');
}

/** `@angular/common` for `@angular/common/http`. */
function packageName(specifier: string): string {
  return specifier.split('/').slice(0, 2).join('/');
}

/** The major of `22.1.0` or `23.0.0-next.1`. */
function majorOf(version: string): number | undefined {
  const match = /^(\d+)\./.exec(version);
  return match ? Number(match[1]) : undefined;
}

/**
 * The version of `name` to compare with for `major`: the newest release of
 * that major, or, for a major still in prerelease, the package's own `next`
 * tag when it belongs to that major. Offline, the newest version of that
 * major already in the typings cache, since a published version never
 * changes and an earlier run may have fetched it.
 */
async function versionAt(name: string, major: number, prerelease: boolean, offline: boolean): Promise<string | undefined> {
  if (offline) {
    const prefix = `${name.replace('/', '+')}@${major}.`;
    let entries: string[] = [];
    try {
      entries = readdirSync(join(cacheDirectory(), 'packages'));
    } catch {
      return undefined;
    }
    const versions = entries.filter((entry) => entry.startsWith(prefix) && !entry.includes('.partial-')).map((entry) => entry.slice(prefix.length - `${major}.`.length));
    return versions.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
  }
  if (prerelease) {
    const next = (await fetchPackument(name))?.next;
    return next && majorOf(next) === major ? next : undefined;
  }
  return resolveVersion(name, `^${major}.0.0`);
}
