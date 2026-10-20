import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageCompatibility } from './compatibility.js';
import type { DeprecationIndex } from './deprecations.js';
import type { SourceFileFacts, TemplateFact } from './scan.js';

/**
 * Results that can be reused between runs on the same repository, for
 * `--watch`. Passed in through `CheckupOptions.cache` and filled by
 * `buildContext`; a single run without one behaves exactly as before.
 *
 * - Per file: the scanned facts, kept while the file's mtime and size are
 *   unchanged. Parsing is most of a run, so an edit to one file re-parses one.
 * - Per dependency set: the deprecation index, the registry lookups and the
 *   latest Angular version, kept until `package.json`, a lockfile or
 *   `node_modules` changes. Re-fetching the registry on every keystroke would
 *   be slow and impolite.
 */
export interface AnalysisCache {
  files: Map<string, { stamp: string; facts: SourceFileFacts | TemplateFact }>;
  dependencies?: {
    stamp: string;
    deprecations: DeprecationIndex;
    compatibility: PackageCompatibility[];
    latestAngular: { major: number; source: 'registry' | 'bundled' };
  };
}

/** An empty cache. */
export function createAnalysisCache(): AnalysisCache {
  return { files: new Map() };
}

/** `mtime:size` of a file, or an empty string when it cannot be read. */
export function fileStamp(path: string): string {
  try {
    const stats = statSync(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return '';
  }
}

/** The stamp of everything that decides the installed dependencies. */
export function dependencyStamp(root: string): string {
  return ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'node_modules/.package-lock.json'].map((name) => fileStamp(join(root, name))).join('|');
}

/**
 * The cached value for `path` when its stamp still matches, else `compute()`
 * stored under the new stamp. Without a cache it just computes.
 */
export function cachedFacts<T extends SourceFileFacts | TemplateFact>(cache: AnalysisCache | undefined, path: string, compute: () => T): T {
  if (!cache) return compute();
  const stamp = fileStamp(path);
  const hit = cache.files.get(path);
  if (hit && hit.stamp === stamp) return hit.facts as T;
  const facts = compute();
  cache.files.set(path, { stamp, facts });
  return facts;
}
