import ts from 'typescript';
import { functionComplexities, nestedSubscribeLines } from '../src/code-shape.js';
import { runCheckup } from '../src/index.js';
import { templateSpeedOf } from '../src/template-speed.js';
import { removeTemp, writeTemp } from './helpers.js';

const parse = (code: string): ts.SourceFile => ts.createSourceFile('a.ts', code, ts.ScriptTarget.Latest, true);
const complexity = (code: string): Record<string, number> => Object.fromEntries(functionComplexities(parse(code)).map((entry) => [entry.name, entry.complexity]));

const angularJson = JSON.stringify({ version: 1, projects: { app: { root: '', projectType: 'application', architect: { build: { builder: '@angular/build:application', options: {} } } } } });

describe('nested subscriptions', () => {
  it('finds a .subscribe() with another inside a callback or an observer, once per outer call', () => {
    const code = [
      'a$.subscribe((a) => {',
      '  b$.subscribe(() => c$.subscribe());',
      '});',
      'd$.subscribe({ next: () => e$.subscribe() });',
      'f$.pipe(switchMap(() => g$)).subscribe();',
    ].join('\n');
    expect(nestedSubscribeLines(parse(code))).toEqual([1, 2, 4]);
  });
});

describe('cognitive complexity', () => {
  it('adds the nesting level to if, loops and ?:, and 1 to else if and else', () => {
    expect(complexity('function f(a, b, c) { if (a) { for (;;) { if (b && c) {} } } }').f).toBe(7);
    expect(complexity('function g(a, b) { if (a) {} else if (b) {} else {} }').g).toBe(3);
    expect(complexity('function h(a) { try {} catch { return a ? 1 : 2; } }').h).toBe(3);
  });

  it('counts each run of && once, and || or ?? not at all, as eslint-plugin-sonarjs does', () => {
    const scores = complexity(
      ['function a(x, y, z) { return x && y && z; }', 'function b(x, y, z) { return x || y || z; }', 'function c(x, y, z, w) { return x && y || z && w; }', 'function d(x, y) { return (x ?? y) && x; }'].join('\n'),
    );
    expect(scores).toEqual({ a: 1, b: 0, c: 2, d: 1 });
  });

  it('measures a nested function on its own, named after what holds it, at the line of its arrow', () => {
    const results = functionComplexities(parse(['class Shop {', '  load(x) {', '    if (x) {}', '    items.map((item) => {', '      if (item) { if (x) {} }', '    });', '  }', '}'].join('\n')));
    expect(results).toEqual([
      { name: 'Shop.load', line: 2, complexity: 1 },
      { name: 'map callback', line: 4, complexity: 3 },
    ]);
  });

  it('raises the nesting of later structures after a function written as a branch of ?:', () => {
    // The plugin's own count: ?: is 1, and the if after it is 1 + 2 carried.
    expect(complexity('function q(a, b) { const h = a ? () => 1 : () => 2; if (b) {} }').q).toBe(4);
  });

  let root = '';
  afterEach(() => root && removeTemp(root));

  it('is a finding over 15 in the architecture check and a measure always', async () => {
    const deep = `export function deep(a: number[]) { ${'if (a) { '.repeat(6)}${'}'.repeat(6)} }\n`;
    root = writeTemp({ 'angular.json': angularJson, 'package.json': JSON.stringify({ dependencies: { '@angular/core': '22.0.0' } }), 'src/main.ts': "import { deep } from './app/deep';\ndeep([]);\n", 'src/app/deep.ts': deep });
    const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'architecture')!;
    expect(check.measures).toContainEqual(expect.objectContaining({ id: 'complex-functions', value: 1 }));
    expect(check.findings.find((finding) => finding.message.includes('cognitive complexity'))).toMatchObject({ severity: 'low', files: [{ path: 'src/app/deep.ts', line: 1 }] });
  });
});

describe('template speed', () => {
  it('finds <img> with src but no ngSrc, leaving data: and blob: out', () => {
    const template = ['<img src="a.png">', '<img [src]="url">', '<img ngSrc="a.png" width="1" height="1">', '<img src="data:image/png;base64,AA">', '<img [ngSrc]="url" fill>'].join('\n');
    expect(templateSpeedOf(template).images).toEqual([1, 2]);
  });

  let root = '';
  afterEach(() => root && removeTemp(root));

  const component = [
    "import { Component } from '@angular/core';",
    '@Component({',
    "  selector: 'app-a',",
    "  template: '<p>{{ total }}</p><p>{{ name }}</p><img src=\"logo.png\">',",
    '})',
    'export class A {',
    '  items = [1, 2];',
    '  get total() { return this.items.reduce((sum, item) => sum + item, 0); }',
    "  get name() { return 'a'; }",
    '}',
  ].join('\n');

  const components = async (angular: string) => {
    root = writeTemp({ 'angular.json': angularJson, 'package.json': JSON.stringify({ dependencies: { '@angular/core': angular } }), 'src/main.ts': '', 'src/app/a.component.ts': component });
    return (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'components')!;
  };

  it('counts reads of a getter that does work, not one that returns a value', async () => {
    const check = await components('22.0.0');
    expect(check.measures).toContainEqual(expect.objectContaining({ id: 'template-getter-calls', value: 1 }));
    expect(check.findings.find((finding) => finding.message.includes('expensive getter'))).toMatchObject({ severity: 'low', files: [{ path: 'src/app/a.component.ts' }] });
  });

  it('finds images without NgOptimizedImage from Angular 15, and measures them on every version', async () => {
    const current = await components('22.0.0');
    expect(current.findings.some((finding) => finding.message.includes('NgOptimizedImage'))).toBe(true);
    removeTemp(root);
    const older = await components('14.2.0');
    expect(older.findings.some((finding) => finding.message.includes('NgOptimizedImage'))).toBe(false);
    expect(older.measures).toContainEqual(expect.objectContaining({ id: 'unoptimized-images', value: 1 }));
  });
});

describe('unused dependencies', () => {
  let root = '';
  afterEach(() => root && removeTemp(root));

  const dependencies = async (files: Record<string, string>) => {
    root = writeTemp({ 'angular.json': angularJson, 'src/main.ts': "import { a } from 'used-lib/sub';\nconsole.log(a);\n", ...files });
    return (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'dependencies')!;
  };

  const declared = {
    '@angular/core': '22.0.0',
    tslib: '2.8.0',
    'used-lib': '1.0.0',
    'styled-lib': '1.0.0',
    'aliased-lib': '1.0.0',
    'host-lib': '1.0.0',
    'peer-lib': '1.0.0',
    '@capacitor/keyboard': '7.0.0',
    'left-over': '1.0.0',
  };
  const workspace = {
    'package.json': JSON.stringify({ dependencies: declared }),
    'src/styles.scss': "@use 'styled-lib/theme';\n",
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { stream: ['./node_modules/aliased-lib'] } } }),
    'capacitor.config.json': '{}',
    'src/app/host.ts': "import 'host-lib';\n",
  };

  it('lists runtime dependencies nothing imports, names or needs as a peer', async () => {
    const check = await dependencies({ ...workspace, 'node_modules/host-lib/package.json': JSON.stringify({ peerDependencies: { 'peer-lib': '*' } }) });
    expect(check.measures).toContainEqual({ id: 'unused-dependencies', label: 'Runtime dependencies nothing uses', value: 1 });
    expect(check.findings.find((finding) => finding.message.includes('nothing uses'))).toMatchObject({ severity: 'low', message: '1 runtime dependency nothing uses: `left-over`', files: [{ path: 'package.json' }] });
  });

  it('reads the peers from package-lock.json when nothing is installed', async () => {
    const lock = JSON.stringify({ packages: { '': {}, 'node_modules/host-lib': { peerDependencies: { 'peer-lib': '*' } } } });
    const check = await dependencies({ ...workspace, 'package-lock.json': lock });
    expect(check.measures).toContainEqual(expect.objectContaining({ id: 'unused-dependencies', value: 1 }));
  });

  it('says nothing when the peers cannot be read', async () => {
    const check = await dependencies(workspace);
    expect((check.measures ?? []).some((measure) => measure.id === 'unused-dependencies')).toBe(false);
    expect(check.findings.some((finding) => finding.message.includes('nothing uses'))).toBe(false);
  });
});
