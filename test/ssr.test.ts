import ts from 'typescript';
import { runCheckup } from '../src/index.js';
import { skipHydrationLines, ssrFactsOf } from '../src/ssr.js';
import { removeTemp, writeTemp } from './helpers.js';

const parse = (code: string): ts.SourceFile => ts.createSourceFile('a.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const facts = (code: string, path = 'src/a.ts') => ssrFactsOf(parse(code), path);
const globals = (code: string, path?: string): number[] => facts(code, path).browserGlobals.map((entry) => entry.line);
const component = (body: string): string => `@Component({ selector: 'a' })\nexport class A {\n${body}\n}`;

describe('code known to run on the server', () => {
  it('finds a global at the top level, in fields, constructors and lifecycle hooks', () => {
    expect(globals(`const w = window.innerWidth;`)).toEqual([1]);
    expect(globals(component(`  width = window.innerWidth;\n  constructor() { localStorage.getItem('a'); }\n  ngOnInit() { document.title = 'x'; }\n  ngAfterViewInit() { navigator.language; }`))).toEqual([3, 4, 5, 6]);
    expect(facts(`@Injectable()\nexport class S {\n  constructor() { sessionStorage.clear(); }\n}`).browserGlobals).toEqual([{ name: 'sessionStorage', line: 3 }]);
  });

  it('follows methods the class calls through this, once each, and only from code that runs', () => {
    expect(globals(component(`  ngOnInit() { this.a(); this.a(); }\n  a() { this.b(); }\n  b() { window.scroll(0, 0); this.a(); }`))).toEqual([5]);
    expect(globals(component(`  onClick() { window.open('x'); }\n  other() { document.title = 'y'; }`))).toEqual([]);
  });

  it('does not follow a call under a guard: everything it reaches runs in the browser only', () => {
    expect(globals(component(`  constructor() {\n    if (this.isBrowser) {\n      this.load();\n    }\n  }\n  load() { localStorage.getItem('a'); }`))).toEqual([]);
    expect(globals(component(`  constructor() {\n    this.load();\n  }\n  load() { document.addEventListener('x', f); }`))).toEqual([6]);
  });

  it('stays silent in callbacks and nested functions, which may run later', () => {
    expect(globals(component(`  ngOnInit() {\n    afterNextRender(() => window.scroll(0, 0));\n    setTimeout(() => document.title);\n    function later() { return navigator.language; }\n  }\n  handler = () => window.open('x');`))).toEqual([]);
    expect(globals(`export function f() { return window; }\nexport const g = () => document;`)).toEqual([]);
  });

  it('accepts every usual guard', () => {
    const guarded = [
      `if (isPlatformBrowser(this.id)) { window.scroll(0, 0); }`,
      `if (this.isBrowser) window.scroll(0, 0);`,
      `if (typeof window !== 'undefined') window.scroll(0, 0);`,
      `const w = this.isBrowser ? window.innerWidth : 0;`,
      `const w = typeof window !== 'undefined' && window.innerWidth;`,
      `if (isPlatformServer(this.id)) { return; }\n    window.scroll(0, 0);`,
      `if (!isPlatformBrowser(this.id)) return;\n    window.scroll(0, 0);`,
      `try { localStorage.getItem('a'); } catch {}`,
    ];
    for (const body of guarded) expect(globals(component(`  ngOnInit() {\n    ${body}\n  }`))).toEqual([]);
    expect(globals(component(`  ngOnInit() {\n    if (this.ready) { window.scroll(0, 0); }\n  }`))).toEqual([4]);
  });

  it('knows a local name from the global, and a property, a type or typeof from a use', () => {
    const silent = [
      `constructor(@Inject(DOCUMENT) private document: Document) { document.title = 'x'; }`,
      `document = inject(DOCUMENT);\n  ngOnInit() { this.document.title = 'x'; }`,
      `ngOnInit() { const window = this.win; window.scroll(0, 0); }`,
      `ngOnInit() { const { document } = this; document.title = 'x'; }`,
      `ngOnInit() { this.x.window.y = 1; const o = { window: 1 }; }`,
      `el: Window | null = null;\n  w = null as unknown as Window;\n  ngOnInit() { const t = typeof window; }`,
    ];
    for (const body of silent) expect(globals(component(`  ${body}`))).toEqual([]);
    expect(globals(component(`  ngOnInit() { const o = { window }; }`))).toEqual([3]);
    expect(globals(`import { window } from './x';\nconst w = window.y;`)).toEqual([]);
  });

  it('leaves out classes Angular does not create, and the browser entry file', () => {
    expect(globals(`export class Plain {\n  w = window.innerWidth;\n}`)).toEqual([]);
    expect(globals(`const w = window.innerWidth;\n${component('  a = window;')}`, 'src/main.ts')).toEqual([]);
  });

  it('finds native DOM changes, guarded or in a hook', () => {
    const found = facts(component(`  ngOnInit() {\n    this.el.nativeElement.appendChild(x);\n    y.innerHTML = '<b></b>';\n    if (this.isBrowser) this.el.nativeElement.remove();\n    this.list.remove();\n  }\n  onClick() { this.el.nativeElement.remove(); }`));
    expect(found.domMutations).toEqual([4, 5]);
  });

  it('finds ngSkipHydration in host metadata and templates, not in comments', () => {
    expect(facts(`@Component({\n  selector: 'a',\n  host: { ngSkipHydration: 'true' },\n})\nexport class A {}`).skipHydration).toEqual([3]);
    expect(skipHydrationLines(`<a></a>\n<b ngSkipHydration></b>\n<!-- <c ngSkipHydration></c> -->\n<d\n  ngSkipHydration="true"></d>\nngSkipHydration in text`)).toEqual([2, 5]);
  });
});

describe('the ssr area', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  const app = (dependencies: Record<string, string>, files: Record<string, string>, options: Record<string, unknown> = { browser: 'src/main.ts' }): string =>
    writeTemp({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^20.0.0', ...dependencies } }),
      'angular.json': JSON.stringify({ projects: { shop: { root: '', projectType: 'application', architect: { build: { builder: '@angular/build:application', options } } } } }),
      'src/main.ts': 'export {};',
      ...files,
    });
  const check = async () => (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'ssr')!;
  const leaky = "import { Component } from '@angular/core';\n@Component({ selector: 'a', template: '<b ngSkipHydration></b>' })\nexport class A {\n  ngOnInit() {\n    window.scroll(0, 0);\n    this.el.nativeElement.remove();\n  }\n}\n";

  it('says nothing without server rendering, however much window there is', async () => {
    root = app({}, { 'src/a.ts': leaky });
    const result = await check();
    expect(result).toMatchObject({ grade: 'info', findings: [] });
    expect(result.measures).toBeUndefined();
    expect(result.summary).toContain('does not render on the server');
  });

  it('reports every rule with a measure and no grade once the app renders on the server', async () => {
    root = app({ '@angular/ssr': '^20.0.0' }, { 'src/a.ts': leaky });
    const result = await check();
    expect(result.grade).toBe('info');
    expect(Object.fromEntries(result.measures!.map((measure) => [measure.id, measure.value]))).toEqual({ 'browser-globals': 1, 'dom-mutations': 1, 'skip-hydration': 1, 'missing-hydration': 1 });
    expect(result.findings.find((finding) => finding.message.includes('browser global'))).toMatchObject({ severity: 'medium', files: [{ path: 'src/a.ts', line: 5 }], count: 1 });
    expect(result.findings.find((finding) => finding.message.includes('provideClientHydration'))?.severity).toBe('medium');
    expect(result.findings.find((finding) => finding.message.includes('ngSkipHydration'))?.files).toEqual([{ path: 'src/a.ts', line: 2 }]);
  });

  it('sees server rendering from the code and the target too, and hydration when it is on', async () => {
    const config = "import { provideClientHydration } from '@angular/platform-browser';\nexport const c = { providers: [provideClientHydration()] };\n";
    root = app({}, { 'src/config.ts': config }, { browser: 'src/main.ts', outputMode: 'server' });
    const fromTarget = await check();
    expect(fromTarget.measures!.find((measure) => measure.id === 'missing-hydration')!.value).toBe(0);
    expect(fromTarget.findings).toEqual([]);
    removeTemp(root);
    root = app({}, { 'src/server.ts': "import { provideServerRendering } from '@angular/ssr';\nexport const p = [provideServerRendering()];\n", 'src/a.ts': leaky });
    expect((await check()).measures!.find((measure) => measure.id === 'browser-globals')!.value).toBe(1);
  });

  it('reads only the projects that render on the server in a workspace of several', async () => {
    root = writeTemp({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^20.0.0', '@angular/ssr': '^20.0.0' } }),
      'angular.json': JSON.stringify({
        projects: {
          site: { root: 'apps/site', projectType: 'application', architect: { build: { builder: '@angular/build:application', options: { browser: 'apps/site/src/main.ts', server: 'apps/site/src/main.server.ts' } } } },
          admin: { root: 'apps/admin', projectType: 'application', architect: { build: { builder: '@angular/build:application', options: { browser: 'apps/admin/src/main.ts' } } } },
        },
      }),
      'apps/site/src/a.ts': leaky,
      'apps/admin/src/b.ts': leaky,
      'apps/site/src/main.ts': 'export {};',
      'apps/admin/src/main.ts': 'export {};',
    });
    const result = await check();
    expect(result.measures!.find((measure) => measure.id === 'browser-globals')!.value).toBe(1);
    expect(result.measures!.find((measure) => measure.id === 'skip-hydration')!.value).toBe(1);
    expect(result.findings.find((finding) => finding.message.includes('browser global'))!.files).toEqual([{ path: 'apps/site/src/a.ts', line: 5 }]);
  });
});
