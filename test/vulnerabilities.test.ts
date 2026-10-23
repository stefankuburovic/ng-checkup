import { securityCheck } from '../src/checks/security.js';
import type { AnalysisContext } from '../src/checks/context.js';
import { lookUpVulnerabilities } from '../src/vulnerabilities.js';
import { resolveWorkspace } from '../src/workspace.js';
import { removeTemp, writeTemp } from './helpers.js';

/** OSV as a fake `fetch`: the batch query answers by package name, details by id. */
function fakeOsv(byPackage: Record<string, string[]>, details: Record<string, unknown>): { fetch: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/querybatch')) {
      const body = JSON.parse(String(init?.body)) as { queries: Array<{ package: { name: string } }> };
      bodies.push(body);
      return new Response(JSON.stringify({ results: body.queries.map((query) => ({ vulns: (byPackage[query.package.name] ?? []).map((id) => ({ id })) })) }));
    }
    const id = decodeURIComponent(url.split('/').pop()!);
    return details[id] ? new Response(JSON.stringify(details[id])) : new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, bodies };
}

const ADVISORIES = {
  'GHSA-jq-1': { id: 'GHSA-jq-1', aliases: ['CVE-2020-11022'], summary: 'XSS in htmlPrefilter', database_specific: { severity: 'MODERATE' }, affected: [{ package: { name: 'jquery' }, ranges: [{ events: [{ introduced: '1.2.0' }, { fixed: '3.5.0' }] }] }] },
  'GHSA-bs-1': { id: 'GHSA-bs-1', aliases: ['CVE-2019-8331'], summary: 'XSS in tooltip', database_specific: { severity: 'HIGH' }, affected: [{ package: { name: 'bootstrap' }, ranges: [{ events: [{ introduced: '3.0.0' }, { fixed: '3.4.1' }, { introduced: '4.0.0' }, { fixed: '4.3.1' }] }] }] },
  'GHSA-ng-1': { id: 'GHSA-ng-1', aliases: ['CVE-2022-25844'], summary: 'ReDoS', database_specific: { severity: 'MODERATE' }, affected: [{ package: { name: 'angular' }, ranges: [{ events: [{ introduced: '1.7.0' }] }] }] },
  'GHSA-karma-1': { id: 'GHSA-karma-1', aliases: [], summary: 'Open redirect', database_specific: { severity: 'MODERATE' }, affected: [{ package: { name: 'karma' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '6.3.16' }] }] }] },
};

describe('known vulnerabilities', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) removeTemp(root);
    root = undefined;
  });

  function workspace() {
    root = writeTemp({
      'package.json': JSON.stringify({ name: 'shop', dependencies: { jquery: '^3.3.1', bootstrap: '~3.3.7', lodash: 'latest' }, devDependencies: { karma: '^3.1.4' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/jquery': { version: '3.3.1' }, 'node_modules/bootstrap': { version: '3.3.7' }, 'node_modules/karma': { version: '3.1.4' } } }),
    });
    return resolveWorkspace(root, [], []);
  }

  it('asks OSV for the direct dependencies at their exact versions, plus AngularJS from a CDN, and picks the nearest fix', async () => {
    const { fetch, bodies } = fakeOsv({ jquery: ['GHSA-jq-1'], bootstrap: ['GHSA-bs-1'], angular: ['GHSA-ng-1'], karma: ['GHSA-karma-1'] }, ADVISORIES);
    const scan = await lookUpVulnerabilities(workspace(), { offline: false, angularJsVersion: '1.8.2', fetch });
    // lodash has no exact version (no lockfile entry), so it is not asked about.
    expect((bodies[0] as { queries: Array<{ package: { name: string }; version: string }> }).queries.map((query) => `${query.package.name}@${query.version}`).sort()).toEqual(['angular@1.8.2', 'bootstrap@3.3.7', 'jquery@3.3.1', 'karma@3.1.4']);
    expect(scan?.checked).toBe(4);
    const bootstrap = scan?.packages.find((entry) => entry.name === 'bootstrap');
    expect(bootstrap?.vulnerabilities[0]).toEqual({ id: 'GHSA-bs-1', cves: ['CVE-2019-8331'], summary: 'XSS in tooltip', severity: 'high', fixedIn: '3.4.1' });
    expect(scan?.packages.find((entry) => entry.name === 'angular')?.vulnerabilities[0]?.fixedIn).toBeUndefined();
    expect(scan?.packages.find((entry) => entry.name === 'karma')?.dev).toBe(true);
    // Runtime first, worst first.
    expect(scan?.packages.map((entry) => entry.name)).toEqual(['bootstrap', 'angular', 'jquery', 'karma']);
  });

  it('is skipped offline and when OSV does not answer', async () => {
    expect(await lookUpVulnerabilities(workspace(), { offline: true })).toBeUndefined();
    const failing = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    expect(await lookUpVulnerabilities(workspace(), { offline: false, fetch: failing })).toBeUndefined();
  });

  it('grades security poor for a high advisory in a runtime dependency, even without TypeScript code', async () => {
    const { fetch } = fakeOsv({ jquery: ['GHSA-jq-1'], bootstrap: ['GHSA-bs-1'], karma: ['GHSA-karma-1'] }, ADVISORIES);
    const scan = await lookUpVulnerabilities(workspace(), { offline: false, fetch });
    const result = securityCheck({ sources: [], templates: [], vulnerabilities: scan, maxExamples: 5 } as unknown as AnalysisContext);
    expect(result.grade).toBe('poor');
    expect(result.findings[0]?.message).toBe('2 known vulnerabilities in 2 dependencies (1 high or critical)');
    expect(result.findings[0]?.detail).toContain('`bootstrap` 3.3.7: 1 advisory (CVE-2019-8331), all fixed by 3.4.1');
    expect(result.findings.at(-1)?.message).toBe('1 known vulnerability in development tooling');
    // Not a measure: the count grows when advisories are published, not when the code gets worse.
    expect(result.measures?.map((measure) => measure.id)).not.toContain('known-vulnerabilities');
  });
});
