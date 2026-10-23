import { join } from 'node:path';
import type { WorkspaceInfo } from './workspace.js';
import { asRecord, readJson } from './workspace.js';

/** One published advisory affecting a package version. */
export interface KnownVulnerability {
  /** The OSV id, a GitHub advisory id such as `GHSA-m2h2-264f-f486` for npm. */
  id: string;
  /** The CVE ids among its aliases, which is what most readers search for. */
  cves: string[];
  summary: string;
  /** As the advisory database rates it; undefined when unrated. */
  severity?: 'low' | 'moderate' | 'high' | 'critical';
  /**
   * The lowest fixed version above the installed one, when the advisory
   * names one; an advisory fixed on several release lines (3.4.1 and 4.3.1)
   * gives the nearest. AngularJS advisories name none.
   */
  fixedIn?: string;
}

/** The advisories of one dependency at its exact version. */
export interface PackageVulnerabilities {
  name: string;
  version: string;
  /** Only in `devDependencies`: tooling, not shipped to users. */
  dev: boolean;
  vulnerabilities: KnownVulnerability[];
}

/** The outcome of `lookUpVulnerabilities`, as `AnalysisContext.vulnerabilities`. */
export interface VulnerabilityScan {
  /** Dependencies whose exact version was checked. */
  checked: number;
  /** Only those with at least one advisory. */
  packages: PackageVulnerabilities[];
}

/** The OSV endpoints; tests pass their own `fetch`. */
const OSV = 'https://api.osv.dev/v1';

/** Advisory details fetched at most, so a very old app cannot turn one run into hundreds of requests. */
const MAX_DETAILS = 150;

/**
 * Looks up the known vulnerabilities of the direct dependencies at their
 * exact versions (installed or locked) in the OSV database (osv.dev), which
 * carries the GitHub advisories for npm. AngularJS loaded from Bower, a CDN
 * or a checked-in copy is looked up as the npm package `angular` too.
 *
 * Direct dependencies only: the full tree is `npm audit`'s job, and the
 * direct ones are those the codebase chose and can upgrade. What leaves the
 * machine is package names and versions, nothing else.
 *
 * @returns Undefined offline, or when OSV cannot be reached in time: a slow
 *   network must not fail a run, and the report then says "not checked".
 */
export async function lookUpVulnerabilities(
  workspace: WorkspaceInfo,
  options: { offline: boolean; angularJsVersion?: string; fetch?: typeof fetch },
): Promise<VulnerabilityScan | undefined> {
  if (options.offline) return undefined;
  const get = options.fetch ?? fetch;
  const packageJson = readJson(join(workspace.root, 'package.json'));
  const runtime = new Set(Object.keys(asRecord(packageJson?.['dependencies'])));
  const targets = Object.keys(workspace.dependencies)
    .map((name) => ({ name, version: workspace.versions[name], dev: !runtime.has(name) }))
    .filter((entry): entry is { name: string; version: string; dev: boolean } => typeof entry.version === 'string' && /^\d+\.\d+\.\d+/.test(entry.version));
  if (options.angularJsVersion && /^\d+\.\d+\.\d+$/.test(options.angularJsVersion) && !targets.some((entry) => entry.name === 'angular')) {
    targets.push({ name: 'angular', version: options.angularJsVersion, dev: false });
  }
  if (targets.length === 0) return { checked: 0, packages: [] };

  try {
    const batch = await get(`${OSV}/querybatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: targets.map((entry) => ({ package: { name: entry.name, ecosystem: 'npm' }, version: entry.version })) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!batch.ok) return undefined;
    const results = asRecord(await batch.json())['results'];
    if (!Array.isArray(results)) return undefined;
    const idsPerTarget = targets.map((_, index) => {
      const vulns = asRecord(results[index])['vulns'];
      return Array.isArray(vulns) ? vulns.map((vuln) => asRecord(vuln)['id']).filter((id): id is string => typeof id === 'string') : [];
    });
    const ids = [...new Set(idsPerTarget.flat())].slice(0, MAX_DETAILS);
    const details = new Map<string, Record<string, unknown>>();
    // A few at a time: OSV is fast, but a hundred parallel requests from one CLI run is rude.
    for (let start = 0; start < ids.length; start += 8) {
      const slice = ids.slice(start, start + 8);
      const fetched = await Promise.all(
        slice.map(async (id) => {
          try {
            const response = await get(`${OSV}/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
            return response.ok ? ([id, asRecord(await response.json())] as const) : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      for (const entry of fetched) if (entry) details.set(entry[0], entry[1]);
    }
    const packages = targets
      .map((target, index) => ({ ...target, vulnerabilities: idsPerTarget[index]!.map((id) => toVulnerability(id, target.name, target.version, details.get(id))) }))
      .filter((entry) => entry.vulnerabilities.length > 0)
      .sort((left, right) => Number(left.dev) - Number(right.dev) || worst(right.vulnerabilities) - worst(left.vulnerabilities) || left.name.localeCompare(right.name));
    return { checked: targets.length, packages };
  } catch {
    return undefined;
  }
}

/** One advisory in the report's shape; what the details lack stays undefined. */
function toVulnerability(id: string, packageName: string, installed: string, detail: Record<string, unknown> | undefined): KnownVulnerability {
  const aliases = Array.isArray(detail?.['aliases']) ? (detail['aliases'] as unknown[]).filter((alias): alias is string => typeof alias === 'string') : [];
  const rating = String(asRecord(detail?.['database_specific'])['severity'] ?? '').toLowerCase();
  const severity = rating === 'low' || rating === 'moderate' || rating === 'high' || rating === 'critical' ? rating : undefined;
  const fixes: string[] = [];
  for (const affected of Array.isArray(detail?.['affected']) ? (detail['affected'] as unknown[]) : []) {
    if (asRecord(asRecord(affected)['package'])['name'] !== packageName) continue;
    for (const range of Array.isArray(asRecord(affected)['ranges']) ? (asRecord(affected)['ranges'] as unknown[]) : []) {
      for (const event of Array.isArray(asRecord(range)['events']) ? (asRecord(range)['events'] as unknown[]) : []) {
        const fixed = asRecord(event)['fixed'];
        if (typeof fixed === 'string' && compareVersions(fixed, installed) > 0) fixes.push(fixed);
      }
    }
  }
  const fixedIn = fixes.sort(compareVersions)[0];
  return {
    id,
    cves: aliases.filter((alias) => alias.startsWith('CVE-')),
    summary: typeof detail?.['summary'] === 'string' ? detail['summary'] : id,
    ...(severity ? { severity } : {}),
    ...(fixedIn ? { fixedIn } : {}),
  };
}

/** Orders two versions numerically (`3.10.0` after `3.9.1`). Good enough for npm release numbers. */
export function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

/** 4 for critical down to 0 for unrated: how a package sorts. */
export function severityRank(severity: KnownVulnerability['severity']): number {
  return severity === 'critical' ? 4 : severity === 'high' ? 3 : severity === 'moderate' ? 2 : severity === 'low' ? 1 : 0;
}

/** The worst rank among some advisories. */
function worst(vulnerabilities: KnownVulnerability[]): number {
  return Math.max(0, ...vulnerabilities.map((vulnerability) => severityRank(vulnerability.severity)));
}
