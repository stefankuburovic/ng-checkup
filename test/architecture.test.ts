import { runCheckup } from '../src/index.js';
import { scanSourceFile, scanTemplate } from '../src/scan.js';
import type { CheckResult } from '../src/types.js';
import { removeTemp, writeTemp } from './helpers.js';

const PACKAGE = JSON.stringify({ dependencies: { '@angular/core': '~22.0.0' } });

/** One check of a run over `files`. */
async function check(id: string, files: Record<string, string>): Promise<CheckResult> {
  const root = writeTemp({ 'package.json': PACKAGE, ...files });
  try {
    return (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === id)!;
  } finally {
    removeTemp(root);
  }
}

describe('scanning for security and architecture facts', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  it('counts only lines that hold code, so documenting a file does not make it large', () => {
    root = writeTemp({
      'doc.ts': [
        '/**',
        ' * A service.',
        ' */',
        'export class Service {',
        '',
        '  /** The value. */',
        '  value = 1; // trailing comment',
        '  // a line comment',
        '  text = `one',
        'two`;',
        '}',
      ].join('\n'),
    });
    // class line, value, the two lines of the template literal, closing brace
    expect(scanSourceFile(root, `${root}/doc.ts`).linesOfCode).toBe(5);
  });

  it('counts a subscribe on a local as tied when the local was bound where it was declared', () => {
    root = writeTemp({
      'c.ts': [
        "import { Component } from '@angular/core';",
        "@Component({ selector: 'x', template: '' })",
        'export class X {',
        '  ngOnInit() {',
        '    const order$ = this.order$.pipe(takeUntilDestroyed(this.destroyRef));',
        '    order$.subscribe();',
        '    const name$ = (iri: string) => this.api.get(iri).pipe(take(1));',
        "    name$('a').subscribe();",
        '    const open$ = this.store.list$;',
        '    open$.subscribe();',
        '  }',
        '}',
      ].join('\n'),
    });
    expect(scanSourceFile(root, `${root}/c.ts`).manualSubscribes).toEqual([
      { line: 6, bound: true },
      { line: 8, bound: true },
      { line: 10, bound: false },
    ]);
  });

  it('finds sanitizer bypasses, direct DOM writes, eval, routes, constructor injection and class guards', () => {
    root = writeTemp({
      'a.ts': [
        "import { Component, Injectable } from '@angular/core';",
        "import { CanActivate, Routes } from '@angular/router';",
        "import { HttpInterceptor } from '@angular/common/http';",
        'export const routes: Routes = [',
        "  { path: '', component: Home },",
        "  { path: 'about', loadComponent: () => import('./about').then((m) => m.About) },",
        "  { path: 'old', redirectTo: '' },",
        '];',
        "@Component({ selector: 'x', template: '<p [innerHTML]=\"html\"></p>' })",
        'export class X {',
        '  constructor(private sanitizer: DomSanitizer, private el: ElementRef, private renderer: Renderer2) {}',
        '  run(value: string) {',
        '    this.sanitizer.bypassSecurityTrustHtml(value);',
        '    this.el.nativeElement.innerHTML = value;',
        "    this.el.nativeElement.insertAdjacentHTML('beforeend', value);",
        "    this.renderer.setProperty(this.el.nativeElement, 'innerHTML', value);",
        "    this.renderer.setProperty(this.el.nativeElement, 'textContent', value);",
        '    document.write(value);',
        '    eval(value);',
        "    new Function('return 1');",
        '  }',
        '}',
        '@Injectable() export class Guard implements CanActivate { canActivate() { return true; } }',
        '@Injectable() export class Auth implements HttpInterceptor { intercept() {} }',
        'export class Plain { constructor(private a: string) {} }',
      ].join('\n'),
    });
    const facts = scanSourceFile(root, `${root}/a.ts`);
    expect(facts.routes).toEqual({ eager: [5], lazy: [6] });
    expect(facts.bypassSecurityLines).toEqual([13]);
    expect(facts.unsafeDomLines).toEqual([14, 15, 16, 18]);
    expect(facts.dynamicCodeLines).toEqual([19, 20]);
    expect(facts.constructorInjections).toEqual([{ name: 'X', line: 11, parameters: 3 }]);
    expect(facts.classGuards.map((entry) => [entry.name, entry.kind])).toEqual([
      ['Guard', 'CanActivate'],
      ['Auth', 'HttpInterceptor'],
    ]);
    expect(facts.inlineTemplates[0]!.stats.innerHtmlBindings).toBe(1);
  });

  it('does not count HTML the code wrote itself: clearing an element, fixed markup', () => {
    root = writeTemp({
      'b.ts': [
        'export function f(el: HTMLElement, r: Renderer2, name: string) {',
        "  el.innerHTML = '';",
        "  el.innerHTML = '<ion-icon name=\"a\"></ion-icon>' + `<ion-icon name=\"b\"></ion-icon>`;",
        "  el.insertAdjacentHTML('beforeend', '<hr>');",
        "  r.setProperty(el, 'innerHTML', '');",
        '  el.innerHTML = `<b>${name}</b>`;',
        "  el.innerHTML = '<b>' + name + '</b>';",
        '}',
      ].join('\n'),
    });
    expect(scanSourceFile(root, `${root}/b.ts`).unsafeDomLines).toEqual([6, 7]);
  });

  it('counts [innerHTML] and [outerHTML] bindings in templates, in either spelling', () => {
    expect(scanTemplate('<div [innerHTML]="a"></div><div [innerHtml]="b"></div><p [outerHTML]="c"></p>').innerHtmlBindings).toBe(3);
  });
});

describe('the security check', () => {
  it('is poor for direct DOM writes, fair for a bypass, good otherwise', async () => {
    expect((await check('security', { 'a.ts': 'export function f(el: HTMLElement, v: string) { el.innerHTML = v; }' })).grade).toBe('poor');
    const fair = await check('security', { 'a.ts': 'export function f(s: { bypassSecurityTrustUrl(v: string): unknown }) { return s.bypassSecurityTrustUrl("x"); }' });
    expect(fair.grade).toBe('fair');
    expect(fair.findings[0]).toMatchObject({ severity: 'medium', files: [{ path: 'a.ts', line: 1 }], count: 1 });
    const good = await check('security', { 'a.ts': 'export const a = 1;', 'a.html': '<p [innerHTML]="x"></p>' });
    expect(good.grade).toBe('good');
    expect(good.findings.map((finding) => finding.severity)).toEqual(['low']);
  });

  it('ignores spec files', async () => {
    expect((await check('security', { 'a.ts': 'export const a = 1;', 'a.spec.ts': 'document.body.innerHTML = "<p></p>";' })).grade).toBe('good');
  });
});

describe('the architecture check', () => {
  const routes = (eager: number, lazy: number) =>
    `export const routes = [${[
      ...Array.from({ length: eager }, (_, index) => `{ path: 'e${index}', component: A }`),
      ...Array.from({ length: lazy }, (_, index) => `{ path: 'l${index}', loadComponent: () => import('./a') }`),
    ].join(', ')}];`;

  it('grades lazy loading: poor with ten eager routes and none lazy, fair when most are eager, good when most are lazy', async () => {
    const poor = await check('architecture', { 'routes.ts': routes(10, 0) });
    expect(poor.grade).toBe('poor');
    expect(poor.findings[0]).toMatchObject({ severity: 'high', message: 'All 10 routes load eagerly', count: 10 });
    expect((await check('architecture', { 'routes.ts': routes(4, 2) })).grade).toBe('fair');
    expect((await check('architecture', { 'routes.ts': routes(1, 5) })).grade).toBe('good');
  });

  it('counts a component route inside a lazily loaded module as lazy', async () => {
    const angularJson = JSON.stringify({ projects: { app: { root: '', architect: { build: { builder: '@angular/build:application', options: { browser: 'src/main.ts' } } } } } });
    const eagerRoutes = Array.from({ length: 6 }, (_, index) => `{ path: 'a${index}', component: A }`).join(', ');
    const result = await check('architecture', {
      'angular.json': angularJson,
      'src/main.ts': "import { routes } from './app.routes';\nexport const app = routes;",
      'src/app.routes.ts': "export const routes = [{ path: 'admin', loadChildren: () => import('./admin/admin.module') }, { path: '', component: Home }];",
      // Six component routes, but the module is only reached through import().
      'src/admin/admin.module.ts': `export const adminRoutes = [${eagerRoutes}];`,
    });
    expect(result.metrics[0]).toMatchObject({ label: 'Lazy routes', value: '88%', hint: '7 of 8' });
    expect(result.grade).toBe('good');
  });

  it('lists large files and grades on the very large ones', async () => {
    const lines = (count: number) => Array.from({ length: count }, (_, index) => `export const v${index} = ${index};`).join('\n');
    const result = await check('architecture', { 'big.ts': lines(1200), 'medium.ts': lines(600), 'small.ts': lines(10) });
    expect(result.grade).toBe('fair');
    expect(result.findings[0]).toMatchObject({ severity: 'medium', message: '2 files over 500 lines, 1 over 1 000', files: [{ path: 'big.ts' }, { path: 'medium.ts' }] });
    expect(result.measures).toContainEqual({ id: 'very-large-files', label: 'Files over 1000 lines', value: 1 });
  });

  it('reports constructor injection and class guards without grading them', async () => {
    const result = await check('architecture', {
      'a.ts': "import { Injectable } from '@angular/core';\nimport { CanActivate } from '@angular/router';\n@Injectable() export class G implements CanActivate { constructor(private x: X) {} canActivate() { return true; } }",
    });
    expect(result.grade).toBe('good');
    expect(result.findings.map((finding) => finding.message)).toEqual(['1 class-based guard or interceptor', '1 class injects through the constructor']);
  });
});
