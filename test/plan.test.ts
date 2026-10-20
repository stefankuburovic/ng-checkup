import { buildPlan, satisfies } from '../src/plan.js';
import { runCheckup } from '../src/index.js';
import type { AngularVersionInfo } from '../src/angular-versions.js';
import { fixture } from './helpers.js';

describe('buildPlan', () => {
  it('plans one step per major and schedules each migration once, at the first step that ships it', async () => {
    const report = await runCheckup(fixture('legacy-app'), { offline: true, plan: true });
    const plan = report.plan!;
    expect(plan.from).toBe(15);
    expect(plan.steps.map((step) => step.to)).toEqual([16, 17, 18, 19, 20, 21, 22]);
    expect(plan.steps[0]!.command).toBe('ng update @angular/core@16 @angular/cli@16 @angular/material@16');

    const at = (major: number) => plan.steps.find((step) => step.to === major)!.items.map((item) => item.title);
    expect(at(16)).toContain('Convert NgModule components to standalone');
    expect(at(16)).toContain('Replace @angular/flex-layout first');
    expect(at(16)).toContain('Update NgRx to 16 in the same step');
    expect(at(17)).toContain('Move templates to built-in control flow');
    expect(at(18)).toContain('Switch to the esbuild application builder');
    expect(at(19)).toContain('Convert @Input() and @Output() to signal inputs and outputs');
    expect(at(21)).toEqual(expect.arrayContaining(['Move unit tests from Karma to Vitest', 'Prepare for zoneless: move components to OnPush, then drop zone.js']));
    expect(plan.steps.flatMap((step) => step.items).filter((item) => item.title.startsWith('Convert NgModule'))).toHaveLength(1);

    expect(plan.before.map((item) => item.title)).toEqual(['Move from TSLint to ESLint', 'Break the import cycles']);
    expect(plan.steps.find((step) => step.to === 16)!.items.find((item) => item.title.startsWith('Convert NgModule'))!.count).toBe(2);
  });

  it('is absent without --plan, on the latest major, and when the version is unknown', async () => {
    expect((await runCheckup(fixture('legacy-app'), { offline: true })).plan).toBeUndefined();
    expect((await runCheckup(fixture('modern-app'), { offline: true, plan: true })).plan).toBeUndefined();
  });

  it('still plans a major newer than the snapshot, without requirements', async () => {
    const report = await runCheckup(fixture('legacy-app'), { offline: true });
    const versions: AngularVersionInfo[] = [{ major: 16, version: '16.2.12', node: '^16.14.0 || >=18.10.0', typescript: '>=4.9.3 <5.2', rxjs: null, zoneJs: null }];
    const workspace = { root: fixture('legacy-app'), name: 'x', kind: 'angular-cli' as const, dependencies: {}, hasNodeModules: false, angular: { major: 15 }, targets: [], projects: [], polyfills: [] };
    const plan = buildPlan(workspace, report.checks, 17, versions)!;
    expect(plan.steps.map((step) => [step.to, step.requirements.length])).toEqual([[16, 2], [17, 0]]);
    expect(plan.steps[1]!.items[0]!.title).toBe('Check the requirements for this major');
  });
});

describe('satisfies', () => {
  it('handles the range shapes Angular publishes', () => {
    expect(satisfies([4, 3, 5], '>=4.4.2 <4.7')).toBe(false);
    expect(satisfies([4, 6, 4], '>=4.4.2 <4.7')).toBe(true);
    expect(satisfies([16, 20, 0], '^14.20.0 || ^16.13.0 || >=18.10.0')).toBe(true);
    expect(satisfies([15, 0, 0], '^14.20.0 || ^16.13.0 || >=18.10.0')).toBe(false);
    expect(satisfies([0, 11, 8], '~0.13.0')).toBe(false);
    expect(satisfies([0, 13, 3], '~0.11.4 || ~0.12.0 || ~0.13.0')).toBe(true);
    expect(satisfies([6, 0, 3], '6.0.x')).toBe(true);
    expect(satisfies([6, 1, 0], '6.0.x')).toBe(false);
    expect(satisfies([0, 15, 1], '^0.15.0')).toBe(true);
    expect(satisfies([0, 16, 0], '^0.15.0')).toBe(false);
  });
});

describe('the plan in the reports', () => {
  it('appears in Markdown and HTML with each step and its command', async () => {
    const { renderMarkdown, renderHtml } = await import('../src/index.js');
    const report = await runCheckup(fixture('legacy-app'), { offline: true, plan: true });
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('## Upgrade plan: Angular 15 → 22');
    expect(markdown).toContain('### → 17 (17.3.12)');
    expect(markdown).toContain('ng generate @angular/core:control-flow');
    expect(renderHtml(report)).toContain('Upgrade plan: Angular 15 → 22');
  });
});

describe('TSLint in the plan', () => {
  it('asks to remove leftovers when angular-eslint is already set up, and to migrate otherwise', async () => {
    const { removeTemp, writeTemp } = await import('./helpers.js');
    const planFor = async (devDependencies: Record<string, string>) => {
      const root = writeTemp({ 'package.json': JSON.stringify({ dependencies: { '@angular/core': '~17.0.0' }, devDependencies }), 'src/a.ts': 'export const a = 1;' });
      try {
        return (await runCheckup(root, { offline: true, plan: true })).plan!.before;
      } finally {
        removeTemp(root);
      }
    };
    expect(await planFor({ codelyzer: '^6.0.0', '@angular-eslint/builder': '^17.0.0' })).toContainEqual(expect.objectContaining({ title: 'Remove the TSLint leftovers', command: 'npm uninstall codelyzer' }));
    expect((await planFor({ tslint: '~6.1.0' })).map((item) => item.title)).toContain('Move from TSLint to ESLint');
  });
});
