import { buildDeprecationIndexFrom, installedIndexedPackages, isIndexedPackage, type DeprecationIndex } from './deprecations.js';
import { inBatches, resolveVersion } from './compatibility.js';
import { packageTypings } from './package-store.js';
import type { SourceFileFacts } from './scan.js';
import type { WorkspaceInfo } from './workspace.js';

/** Where the typings behind the deprecation index came from. */
export interface TypingsSource {
  /** `node_modules` when everything indexed was installed, `registry` when any of it was downloaded, `none` when nothing could be read. */
  source: 'node_modules' | 'registry' | 'none';
  /** Indexed packages the code imports whose typings could not be read: neither installed nor downloadable. */
  missing: string[];
}

/**
 * The deprecation index for the packages this code imports, from wherever
 * their typings can be had: installed in `node_modules` first, else the exact
 * version the lockfile pins (or the highest that `package.json` allows)
 * downloaded from the npm registry into the cache.
 *
 * Only packages the source actually imports are downloaded, so a repository
 * pays for `@angular/core` and the handful of entry points it uses, not for
 * every `@angular/*` package in its dependencies. With `offline`, only
 * typings already in the cache are used.
 */
export async function loadDeprecationIndex(root: string, workspace: WorkspaceInfo, sources: SourceFileFacts[], offline: boolean): Promise<{ index: DeprecationIndex; typings: TypingsSource }> {
  const installed = installedIndexedPackages(root);
  const installedNames = new Set(installed.map(([name]) => name));
  const imported = new Set<string>();
  for (const file of sources) {
    for (const fact of file.imports) {
      const name = packageName(fact.specifier);
      if (name && isIndexedPackage(name) && !installedNames.has(name)) imported.add(name);
    }
  }
  const downloaded: Array<[string, string]> = [];
  const missing: string[] = [];
  await inBatches([...imported].sort(), 4, async (name) => {
    const version = workspace.versions[name] ?? (offline ? undefined : await resolveVersion(name, workspace.dependencies[name]));
    const directory = version ? await packageTypings(name, version, offline) : undefined;
    if (directory) downloaded.push([name, directory]);
    else missing.push(name);
  });
  const packages = [...installed, ...downloaded.sort(([left], [right]) => left.localeCompare(right))];
  return {
    index: buildDeprecationIndexFrom(packages),
    typings: { source: downloaded.length > 0 ? 'registry' : installed.length > 0 ? 'node_modules' : 'none', missing: missing.sort() },
  };
}

/** `@angular/common` for `@angular/common/http`, `rxjs` for `rxjs/operators`; undefined for a relative path. */
function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined) : parts[0];
}
