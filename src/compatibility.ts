import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { END_OF_LIFE_PACKAGES } from './checks/version.js';
import { satisfies } from './plan.js';
import { asRecord, readJson, type WorkspaceInfo } from './workspace.js';

/**
 * Packages left out: Angular's own (moved by `ng update`), NgRx (follows
 * Angular majors and is planned with them), Nx (moved by `nx migrate`), the
 * runtime trio the upgrade plan already lists by version range, and the
 * end-of-life packages the version check reports for removal. `codelyzer`
 * was the case: graded poor here for having no Angular 22 release, while the
 * plan's first step already removes it with TSLint.
 */
const EXCLUDED_PREFIXES = ['@angular/', '@angular-devkit/', '@schematics/', '@ngrx/', '@nx/', '@nrwl/'];
const EXCLUDED_NAMES = new Set(['typescript', 'rxjs', 'zone.js', 'tslib', 'nx', 'ng-checkup', ...END_OF_LIFE_PACKAGES.map((entry) => entry.name)]);

/** A release of a package and the Angular range it declares. */
export interface PackageRelease {
  version: string;
  angularRange: string;
}

/** How one third-party package that depends on Angular fits the installed and the latest Angular. */
export interface PackageCompatibility {
  name: string;
  installed: string;
  /** The `@angular/core` peer range of the installed version. */
  angularRange: string;
  /** False when the installed version does not even accept the Angular in use (forced with overrides or --legacy-peer-deps). */
  supportsCurrent: boolean;
  /** The first major after the current one its installed version does not accept. Undefined when it accepts all of them. */
  blocksAt?: number;
  /**
   * From the registry: for every major the installed version does not accept,
   * the lowest released version that does (null when none does yet). Absent
   * when offline or the lookup failed.
   */
  releaseFor?: Record<number, PackageRelease | null>;
  /** The npm deprecation message of the latest version, when it has one. */
  deprecated?: string;
  latest?: string;
}

/**
 * Reads which installed packages depend on `@angular/core` and how far their
 * declared support reaches, then (online) asks the registry for releases that
 * reach further.
 *
 * Generic on purpose: PrimeNG, Kendo, ng-bootstrap, NGXS, Transloco and the
 * rest are all covered by their own `peerDependencies`, with no list of known
 * libraries to keep up to date. A package that declares no Angular peer is
 * not about Angular and is skipped.
 *
 * Empty when dependencies are not installed or the Angular version is unknown.
 * Registry lookups run eight at a time with a four-second timeout each, and a
 * failure leaves that package without `releaseFor` rather than failing the run.
 */
export async function readCompatibility(workspace: WorkspaceInfo, target: number, offline: boolean): Promise<PackageCompatibility[]> {
  const current = workspace.angular.major;
  if (current === undefined || !workspace.hasNodeModules) return [];

  const results: PackageCompatibility[] = [];
  for (const name of Object.keys(workspace.dependencies).sort()) {
    if (EXCLUDED_NAMES.has(name) || EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const packageJsonPath = join(workspace.root, 'node_modules', name, 'package.json');
    if (!existsSync(packageJsonPath)) continue;
    const packageJson = readJson(packageJsonPath);
    const angularRange = asRecord(packageJson?.['peerDependencies'])['@angular/core'];
    const installed = packageJson?.['version'];
    if (typeof angularRange !== 'string' || typeof installed !== 'string') continue;
    const accepts = (major: number): boolean => satisfies([major, 0, 0], angularRange) || satisfies([major, 99, 99], angularRange);
    let blocksAt: number | undefined;
    for (let major = current + 1; major <= target; major++) {
      if (!accepts(major)) {
        blocksAt = major;
        break;
      }
    }
    results.push({ name, installed, angularRange, supportsCurrent: accepts(current), blocksAt });
  }

  if (!offline) {
    // Every package is looked up for its deprecation status; only blocking ones need the release search.
    const needsLookup = new Set(results.filter((entry) => entry.blocksAt !== undefined || !entry.supportsCurrent));
    await inBatches(results, 8, async (entry) => {
      const document = await fetchPackument(entry.name);
      if (!document) return;
      entry.latest = document.latest;
      entry.deprecated = document.versions[document.latest]?.deprecated;
      if (!needsLookup.has(entry)) return;
      const releaseFor: Record<number, PackageRelease | null> = {};
      const installedVersion = parse(entry.installed);
      const candidates = Object.entries(document.versions)
        .filter(([version]) => !version.includes('-'))
        .map(([version, data]) => ({ version, parsed: parse(version), angularRange: data.angularRange }))
        .filter((release): release is { version: string; parsed: [number, number, number]; angularRange: string } => release.parsed !== undefined && typeof release.angularRange === 'string')
        .filter((release) => !installedVersion || compare(release.parsed, installedVersion) >= 0)
        .sort((left, right) => compare(left.parsed, right.parsed));
      // From the current major, so a package that does not even accept it gets its fix too.
      for (let major = workspace.angular.major ?? 0; major <= target; major++) {
        if (satisfies([major, 0, 0], entry.angularRange) || satisfies([major, 99, 99], entry.angularRange)) continue;
        const match = candidates.find((release) => satisfies([major, 0, 0], release.angularRange) || satisfies([major, 99, 99], release.angularRange));
        releaseFor[major] = match ? { version: match.version, angularRange: match.angularRange } : null;
      }
      entry.releaseFor = releaseFor;
    });
  }
  return results;
}

/** The parts of an npm packument the check reads. */
interface Packument {
  latest: string;
  versions: Record<string, { angularRange?: string; deprecated?: string }>;
}

/**
 * Fetches the abbreviated packument (the form `npm install` uses, which keeps
 * peer dependencies and deprecation messages but drops readmes). Undefined on
 * any failure: offline, unknown package, private registry, timeout.
 */
async function fetchPackument(name: string): Promise<Packument | undefined> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return undefined;
    const body = asRecord(await response.json());
    const latest = asRecord(body['dist-tags'])['latest'];
    if (typeof latest !== 'string') return undefined;
    const versions: Packument['versions'] = {};
    for (const [version, data] of Object.entries(asRecord(body['versions']))) {
      const record = asRecord(data);
      const peer = asRecord(record['peerDependencies'])['@angular/core'];
      const deprecated = record['deprecated'];
      versions[version] = { angularRange: typeof peer === 'string' ? peer : undefined, deprecated: typeof deprecated === 'string' ? deprecated : undefined };
    }
    return { latest, versions };
  } catch {
    return undefined;
  }
}

/** Runs `work` over `items`, at most `size` at a time. */
async function inBatches<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += size) await Promise.all(items.slice(start, start + size).map(work));
}

/** `[major, minor, patch]` of a plain version. */
function parse(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Orders two versions. */
function compare(left: [number, number, number], right: [number, number, number]): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** The highest Angular major a range accepts among `majors`, for messages such as "supports Angular up to 13". */
export function highestSupported(range: string, majors: number[]): number | undefined {
  return [...majors].reverse().find((major) => satisfies([major, 0, 0], range) || satisfies([major, 99, 99], range));
}

