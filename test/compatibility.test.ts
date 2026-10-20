import { readCompatibility, type PackageCompatibility } from '../src/compatibility.js';
import { runCheckup } from '../src/index.js';
import { buildPlan } from '../src/plan.js';
import { readWorkspace } from '../src/workspace.js';
import { removeTemp, writeTemp } from './helpers.js';

/** A workspace on Angular 15 with installed third-party packages declaring these Angular peer ranges. */
function workspaceWith(peers: Record<string, string | undefined>): string {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ dependencies: { '@angular/core': '~15.2.0', ...Object.fromEntries(Object.keys(peers).map((name) => [name, '*'])) } }),
    'node_modules/@angular/core/package.json': JSON.stringify({ name: '@angular/core', version: '15.2.10' }),
    'src/app.ts': 'export const x = 1;',
  };
  for (const [name, range] of Object.entries(peers)) {
    files[`node_modules/${name}/package.json`] = JSON.stringify({ name, version: '3.2.1', ...(range ? { peerDependencies: { '@angular/core': range } } : {}) });
  }
  return writeTemp(files);
}

describe('readCompatibility (offline)', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  it('finds what blocks the next steps and what does not accept the current version', async () => {
    root = workspaceWith({ 'ngx-old': '^15.0.0', 'ngx-wide': '>=14.0.0', 'ngx-broken': '^12.0.0 || ^13.0.0', lodash: undefined, '@ngrx/store': '^15.0.0' });
    const result = await readCompatibility(readWorkspace(root, []), 22, true);
    expect(result.map((entry) => [entry.name, entry.supportsCurrent, entry.blocksAt])).toEqual([
      ['ngx-broken', false, 16],
      ['ngx-old', true, 16],
      ['ngx-wide', true, undefined],
    ]);
  });

  it('grades the check from it: a package that does not accept Angular 15 is poor', async () => {
    root = workspaceWith({ 'ngx-old': '^15.0.0', 'ngx-broken': '^12.0.0' });
    const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'dependencies')!;
    expect(check.grade).toBe('poor');
    expect(check.findings.map((finding) => finding.message)).toEqual([
      '`ngx-broken` 3.2.1 does not accept Angular 15',
      '`ngx-old` 3.2.1 supports Angular up to 15: it blocks the step to 16',
      'Run without --offline to find the releases that support newer Angular versions',
    ]);
    expect(check.measures).toContainEqual({ id: 'peer-mismatches', label: 'Packages that do not accept the installed Angular', value: 1 });
  });

  it('is good when every package keeps up, and info without node_modules', async () => {
    root = workspaceWith({ 'ngx-wide': '>=14.0.0' });
    expect((await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'dependencies')!.grade).toBe('good');
    removeTemp(root);
    root = writeTemp({ 'package.json': JSON.stringify({ dependencies: { '@angular/core': '~15.2.0' } }) });
    expect((await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'dependencies')!.grade).toBe('info');
  });
});

describe('third-party packages in the upgrade plan', () => {
  it('schedules each update at the step that needs it, and follows the new range afterwards', async () => {
    const root = workspaceWith({});
    try {
      const report = await runCheckup(root, { offline: true });
      const compatibility: PackageCompatibility[] = [
        {
          name: 'ngx-old',
          installed: '3.2.1',
          angularRange: '^15.0.0',
          supportsCurrent: true,
          blocksAt: 16,
          releaseFor: { 16: { version: '4.0.0', angularRange: '>=16.0.0 <19.0.0' }, 19: { version: '5.0.0', angularRange: '>=19.0.0' } },
        },
        { name: 'ngx-dead', installed: '1.0.0', angularRange: '^15.0.0 || ^16.0.0', supportsCurrent: true, blocksAt: 17, releaseFor: { 17: null } },
        { name: 'ngx-broken', installed: '2.0.0', angularRange: '^12.0.0', supportsCurrent: false, releaseFor: { 15: { version: '2.5.0', angularRange: '^15.0.0' } } },
      ];
      const plan = buildPlan(readWorkspace(root, []), report.checks, 19, undefined, compatibility)!;
      const titles = (major: number) => plan.steps.find((step) => step.to === major)!.items.map((item) => item.title);
      expect(plan.before[0]).toMatchObject({ title: 'Fix ngx-broken: version 2.0.0 does not accept Angular 15', command: 'npm install ngx-broken@2.5.0' });
      expect(titles(16)).toContain('Update ngx-old to 4.0.0');
      expect(titles(17)).toContain('ngx-dead has no release for Angular 17');
      expect(titles(18)).toEqual([]);
      expect(titles(19)).toContain('Update ngx-old to 5.0.0');
    } finally {
      removeTemp(root);
    }
  });
});
