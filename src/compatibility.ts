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
  if (current === undefined) return [];
  // Without node_modules the registry stands in for it, which needs the network.
  if (!workspace.hasNodeModules && offline) return [];

  // Each packument is fetched at most once per run, whether for the peer
  // range of the used version or for the release search below.
  const packuments = new Map<string, Promise<Packument | undefined>>();
  const packumentOf = (name: string): Promise<Packument | undefined> => {
    let pending = packuments.get(name);
    if (!pending) packuments.set(name, (pending = fetchPackument(name)));
    return pending;
  };

  const candidates = Object.keys(workspace.dependencies)
    .sort()
    .filter((name) => !EXCLUDED_NAMES.has(name) && !EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix)));
  const found = new Map<string, PackageCompatibility>();
  await inBatches(candidates, 8, async (name) => {
    let installed: unknown;
    let angularRange: unknown;
    if (workspace.hasNodeModules) {
      const packageJson = readJson(join(workspace.root, 'node_modules', name, 'package.json'));
      installed = packageJson?.['version'];
      angularRange = asRecord(packageJson?.['peerDependencies'])['@angular/core'];
    } else {
      // The version the lockfile pins (or a fresh install of the range would
      // get), and the peer range that version declares on the registry.
      const document = await packumentOf(name);
      installed = workspace.versions[name] ?? (await resolveVersion(name, workspace.dependencies[name], document));
      angularRange = typeof installed === 'string' ? document?.versions[installed]?.angularRange : undefined;
    }
    if (typeof angularRange !== 'string' || typeof installed !== 'string') return;
    const accepts = (major: number): boolean => satisfies([major, 0, 0], angularRange) || satisfies([major, 99, 99], angularRange);
    let blocksAt: number | undefined;
    for (let major = current + 1; major <= target; major++) {
      if (!accepts(major)) {
        blocksAt = major;
        break;
      }
    }
    found.set(name, { name, installed, angularRange, supportsCurrent: accepts(current), blocksAt });
  });
  const results = candidates.map((name) => found.get(name)).filter((entry): entry is PackageCompatibility => entry !== undefined);

  if (!offline) {
    // Every package is looked up for its deprecation status; only blocking ones need the release search.
    const needsLookup = new Set(results.filter((entry) => entry.blocksAt !== undefined || !entry.supportsCurrent));
    await inBatches(results, 8, async (entry) => {
      const document = await packumentOf(entry.name);
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
export interface Packument {
  latest: string;
  versions: Record<string, { angularRange?: string; deprecated?: string }>;
}

/**
 * Fetches the abbreviated packument (the form `npm install` uses, which keeps
 * peer dependencies and deprecation messages but drops readmes). Undefined on
 * any failure: offline, unknown package, private registry, timeout.
 */
export async function fetchPackument(name: string): Promise<Packument | undefined> {
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

/**
 * The version a fresh install of `range` would get: the highest stable
 * release that satisfies it, from the registry. For a repository without a
 * lockfile, whose `package.json` gives only ranges. Undefined offline, for an
 * unknown package, or when nothing matches.
 */
export async function resolveVersion(name: string, range: string | undefined, packument?: Packument): Promise<string | undefined> {
  if (!range) return undefined;
  if (/^\d+\.\d+\.\d+$/.test(range.trim())) return range.trim();
  const document = packument ?? (await fetchPackument(name));
  if (!document) return undefined;
  const latest = parse(document.latest);
  if (latest && satisfies(latest, range)) return document.latest;
  return Object.keys(document.versions)
    .filter((version) => !version.includes('-'))
    .map((version) => ({ version, parsed: parse(version) }))
    .filter((entry): entry is { version: string; parsed: [number, number, number] } => entry.parsed !== undefined && satisfies(entry.parsed, range))
    .sort((left, right) => compare(right.parsed, left.parsed))[0]?.version;
}

/** Runs `work` over `items`, at most `size` at a time. */
export async function inBatches<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
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

