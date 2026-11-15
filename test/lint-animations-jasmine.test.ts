import ts from 'typescript';
import { runCheckup } from '../src/index.js';
import { testQualityOf } from '../src/test-quality.js';
import { removeTemp, writeTemp } from './helpers.js';

const angularJson = (test?: string): string =>
  JSON.stringify({ version: 1, projects: { app: { root: '', projectType: 'application', architect: { build: { builder: '@angular/build:application', options: {} }, ...(test ? { test: { builder: test, options: {} } } : {}) } } } });

describe('the lint setup', () => {
  let root = '';
  afterEach(() => root && removeTemp(root));

  const findings = async (files: Record<string, string>) => {
    root = writeTemp({ 'angular.json': angularJson(), 'src/main.ts': '', ...files });
    const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'version')!;
    return { check, messages: check.findings.map((finding) => finding.message) };
  };

  it('finds a tslint.json nothing reads, angular-eslint on another major, and no template accessibility rules', async () => {
    const { check, messages } = await findings({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '22.0.0' }, devDependencies: { 'angular-eslint': '20.1.0' } }),
      'tslint.json': '{}',
      'eslint.config.js': "module.exports = [{ files: ['**/*.html'], extends: [angular.configs.templateRecommended] }];",
    });
    expect(messages).toContain('1 `tslint.json` left over without TSLint');
    expect(messages).toContain('angular-eslint on another major than Angular 22: `angular-eslint` 20');
    expect(messages).toContain('ESLint runs angular-eslint without its template accessibility rules');
    expect(check.findings.find((finding) => finding.message.startsWith('ESLint runs'))!.files).toEqual([{ path: 'eslint.config.js' }]);
    expect(check.measures).toContainEqual(expect.objectContaining({ id: 'lint-setup-issues', value: 3 }));
  });

  it('is quiet on a current setup, and leaves tslint.json to the end-of-life finding when TSLint is still installed', async () => {
    const { check, messages } = await findings({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '22.0.0' }, devDependencies: { '@angular-eslint/eslint-plugin': '22.0.1', tslint: '6.1.3' } }),
      'tslint.json': '{}',
      '.eslintrc.json': JSON.stringify({ overrides: [{ files: ['*.html'], extends: ['plugin:@angular-eslint/template/recommended', 'plugin:@angular-eslint/template/accessibility'] }] }),
    });
    expect(messages.filter((message) => /tslint\.json|angular-eslint|ESLint runs/.test(message))).toEqual([]);
    expect(messages).toContain('`tslint` is end of life');
    expect(check.measures).toContainEqual(expect.objectContaining({ id: 'lint-setup-issues', value: 0 }));
  });
});

describe('the animations package', () => {
  let root = '';
  afterEach(() => root && removeTemp(root));

  it('counts application files that import it for its code, and finds them from Angular 20', async () => {
    const files = {
      'angular.json': angularJson(),
      'src/main.ts': '',
      'src/app/a.component.ts': "import { trigger, transition } from '@angular/animations';\nimport { Component } from '@angular/core';\n@Component({ selector: 'app-a', template: '', animations: [trigger('x', [transition(':enter', [])])] })\nexport class A {}\n",
      'src/app/b.ts': "import type { AnimationEvent } from '@angular/animations';\nexport type B = AnimationEvent;\n",
      'src/app/c.ts': "import { provideAnimations } from '@angular/platform-browser/animations';\nexport const c = provideAnimations();\n",
      'src/app/a.component.spec.ts': "import { trigger } from '@angular/animations';\n",
    };
    root = writeTemp({ ...files, 'package.json': JSON.stringify({ dependencies: { '@angular/core': '20.3.0' } }) });
    const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'components')!;
    expect(check.measures).toContainEqual({ id: 'animations-package', label: 'Files using the @angular/animations package', value: 1 });
    expect(check.findings.find((finding) => finding.message.includes('@angular/animations'))).toMatchObject({ severity: 'low', files: [{ path: 'src/app/a.component.ts', line: 1 }] });
    removeTemp(root);
    root = writeTemp({ ...files, 'package.json': JSON.stringify({ dependencies: { '@angular/core': '19.2.0' } }) });
    const older = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'components')!;
    expect(older.findings.some((finding) => finding.message.includes('@angular/animations'))).toBe(false);
    expect(older.measures).toContainEqual(expect.objectContaining({ id: 'animations-package', value: 1 }));
  });
});

describe('Jasmine-only APIs in specs', () => {
  const lines = (code: string): number[] => testQualityOf(ts.createSourceFile('a.spec.ts', code, ts.ScriptTarget.Latest, true)).jasmineOnly!;

  it('finds jasmine.*, its types, spyOn(...).and and a done callback, once per line', () => {
    expect(
      lines(
        [
          "let api: jasmine.SpyObj<Api>;",
          "beforeEach(() => { api = jasmine.createSpyObj('Api', ['get']); });",
          "it('a', () => { spyOn(x, 'y').and.returnValue(1); expect(x).toEqual(jasmine.objectContaining({ a: 1 })); });",
          "it('b', (done) => { done(); });",
          "afterEach(function (done) { done(); });",
          "it('c', async () => { vi.spyOn(x, 'y').mockReturnValue(1); expect(x).toBe(1); });",
        ].join('\n'),
      ),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  let root = '';
  afterEach(() => root && removeTemp(root));

  it('is a measure always and a finding only on Karma, where the move to Vitest is due', async () => {
    const files = {
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '22.0.0' } }),
      'src/main.ts': '',
      'src/app/a.ts': 'export class A {}\n',
      'src/app/a.spec.ts': "it('a', () => { const f = jasmine.createSpy('f'); f(); expect(f).toHaveBeenCalled(); });\n",
    };
    root = writeTemp({ ...files, 'angular.json': angularJson('@angular/build:karma') });
    const karma = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'testing')!;
    expect(karma.measures).toContainEqual(expect.objectContaining({ id: 'jasmine-only-apis', value: 1 }));
    expect(karma.findings.find((finding) => finding.message.includes('only Jasmine'))).toMatchObject({ message: '1 line of specs uses what only Jasmine has', files: [{ path: 'src/app/a.spec.ts', line: 1 }] });
    removeTemp(root);
    root = writeTemp({ ...files, 'angular.json': angularJson('@angular/build:unit-test') });
    const vitest = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'testing')!;
    expect(vitest.findings.some((finding) => finding.message.includes('only Jasmine'))).toBe(false);
    expect(vitest.measures).toContainEqual(expect.objectContaining({ id: 'jasmine-only-apis', value: 1 }));
  });
});
