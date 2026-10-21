import { runCheckup } from '../src/index.js';
import type { Grade, Report } from '../src/types.js';
import { fixture, removeTemp, writeTemp } from './helpers.js';

/** Check id to grade, which is what most of these assertions are about. */
function grades(report: Report): Record<string, Grade> {
  return Object.fromEntries(report.checks.map((check) => [check.id, check.grade]));
}

/** The messages of one check's findings. */
function messages(report: Report, id: string): string[] {
  return report.checks.find((check) => check.id === id)?.findings.map((finding) => finding.message) ?? [];
}

describe('runCheckup on a legacy Angular 15 app', () => {
  let report: Report;
  beforeAll(async () => {
    report = await runCheckup(fixture('legacy-app'), { offline: true });
  });

  it('grades every area that has something to grade', () => {
    expect(grades(report)).toEqual({
      version: 'poor',
      // No node_modules in the fixture, so deprecations cannot be read.
      'deprecated-apis': 'info',
      dependencies: 'info',
      'change-detection': 'fair',
      components: 'poor',
      state: 'fair',
      testing: 'poor',
      'type-safety': 'poor',
      'circular-deps': 'fair',
      architecture: 'good',
      security: 'good',
      bundle: 'info',
    });
  });

  it('counts the upgrade steps against the bundled latest major when offline', () => {
    const version = report.checks.find((check) => check.id === 'version');
    expect(version?.metrics).toContainEqual({ label: 'Latest', value: 22, hint: 'offline, bundled estimate' });
    expect(messages(report, 'version')).toEqual([
      'Angular 15 is 7 majors behind 22 and out of support',
      '1 Angular package on a different major than @angular/core 15',
      '1 project still built with the webpack builder',
      '`@angular/flex-layout` is end of life',
      '`protractor` is end of life',
      '`tslint` is end of life',
    ]);
  });

  it('treats components as module-based and eager by default before Angular 19 and 22', () => {
    expect(messages(report, 'components')[0]).toBe('2 components still declared in NgModules (1 NgModule in total)');
    expect(messages(report, 'change-detection')).toContain('1 component uses eager change detection (50%)');
  });

  it('finds the service and reducer that import each other, ignoring the type-only import in the effects', () => {
    const circular = report.checks.find((check) => check.id === 'circular-deps');
    expect(circular?.findings[0]?.files).toEqual([{ path: 'src/app/hero.service.ts' }, { path: 'src/app/state/hero.reducer.ts' }]);
  });

  it('reports Karma, Protractor and the Jasmine calls a runner move would touch', () => {
    const testing = messages(report, 'testing');
    expect(testing).toContain('Unit tests run on Karma, which is deprecated');
    expect(testing).toContain('End-to-end tests use Protractor, which is end of life');
    expect(report.checks.find((check) => check.id === 'testing')?.findings[0]?.detail).toContain('replacing 2 Jasmine-specific calls');
  });

  it('describes the project', () => {
    expect(report.project).toMatchObject({ name: 'legacy-app', kind: 'angular-cli', angularVersion: '^15.2.0', templateFiles: 1 });
  });
});

describe('runCheckup on a current Angular 22 app', () => {
  it('grades it good everywhere it can, with paths aliases resolved and no false cycle', async () => {
    const report = await runCheckup(fixture('modern-app'), { offline: true });
    expect(grades(report)).toEqual({
      version: 'good',
      'deprecated-apis': 'info',
      dependencies: 'info',
      'change-detection': 'good',
      components: 'good',
      state: 'good',
      testing: 'good',
      'type-safety': 'good',
      'circular-deps': 'good',
      architecture: 'good',
      security: 'good',
      bundle: 'info',
    });
    const components = report.checks.find((check) => check.id === 'components');
    expect(components?.metrics).toContainEqual({ label: 'Signal inputs', value: '100%', hint: '2 of 2' });
    expect(components?.metrics).toContainEqual({ label: '@defer blocks', value: '1' });
  });
});

describe('runCheckup with installed dependencies', () => {
  it('reports what the installed packages deprecate, oldest deprecation first', async () => {
    const report = await runCheckup(fixture('deprecations-app'), { offline: true });
    const deprecated = report.checks.find((check) => check.id === 'deprecated-apis');
    expect(deprecated?.grade).toBe('poor');
    expect(deprecated?.findings.map((finding) => [finding.severity, finding.message])).toEqual([
      ['high', '`APP_INITIALIZER` from @angular/core, used in 1 file'],
      ['high', '`provideLegacyThing` from @angular/core, used in 1 file'],
      ['high', '`NgIf` from @angular/common, used in 1 file'],
      // No version in the tag, so it cannot be overdue.
      ['medium', '`ChangeDetectionStrategy.Default` from @angular/core, used in 1 file'],
      ['high', '1 use of `*ngIf`, `*ngFor` and `[ngSwitch]` in 1 template'],
    ]);
    expect(deprecated?.findings[0]?.detail).toBe('Deprecated since 19.0.0: use provideAppInitializer instead.');
  });

  it('counts a component that sets Default as eager under Angular 22, where OnPush is the default', async () => {
    const report = await runCheckup(fixture('deprecations-app'), { offline: true });
    expect(messages(report, 'change-detection')).toContain('1 component uses eager change detection (100%)');
  });
});

describe('strictness defaults that changed between versions', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  const typeSafety = async (angular: string, typescript: string) => {
    root = writeTemp({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': angular }, devDependencies: { typescript } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022' }, angularCompilerOptions: {} }),
      'src/app.ts': 'export const x = 1;',
    });
    return (await runCheckup(root, { offline: true })).checks.find((check) => check.id === 'type-safety')!;
  };

  it('treats an unset strict and strictTemplates as on for TypeScript 6 and Angular 22, like a new CLI project', async () => {
    const check = await typeSafety('~22.2.0', '~6.0.0');
    expect(check.grade).toBe('good');
    expect(check.metrics).toContainEqual({ label: 'strictNullChecks', value: 'on', hint: 'default in TypeScript 6' });
    expect(check.metrics).toContainEqual({ label: 'strictTemplates', value: 'on', hint: 'default in Angular 22' });
  });

  it('treats them as off before TypeScript 6 and Angular 22', async () => {
    const check = await typeSafety('^21.0.0', '~5.9.0');
    expect(check.grade).toBe('poor');
    expect(check.metrics).toContainEqual({ label: 'strictTemplates', value: 'off', hint: 'default in Angular 21' });
  });
});

describe('webpack builder', () => {
  it('counts a project only when it has no esbuild build, so a deliberate extra webpack target is not an unfinished migration', async () => {
    const { removeTemp, writeTemp } = await import('./helpers.js');
    const workspace = (targets: Record<string, string>) =>
      writeTemp({
        'package.json': JSON.stringify({ dependencies: { '@angular/core': '~22.0.0' } }),
        'angular.json': JSON.stringify({ projects: { app: { root: '', architect: Object.fromEntries(Object.entries(targets).map(([name, builder]) => [name, { builder }])) } } }),
        'src/a.ts': 'export const a = 1;',
      });
    const webpackCount = async (targets: Record<string, string>) => {
      const root = workspace(targets);
      try {
        return (await runCheckup(root, { offline: true })).checks.find((check) => check.id === 'version')!.measures!.find((measure) => measure.id === 'webpack-builders')!.value;
      } finally {
        removeTemp(root);
      }
    };
    expect(await webpackCount({ build: '@angular/build:application', 'build-webpack': '@angular-devkit/build-angular:browser' })).toBe(0);
    expect(await webpackCount({ build: '@angular-devkit/build-angular:browser', 'build-legacy': '@angular-devkit/build-angular:browser' })).toBe(1);
  });
});
