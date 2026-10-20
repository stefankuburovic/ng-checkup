import { parseSize, parseStats, readBundleStats } from '../src/bundle.js';
import { runCheckup } from '../src/index.js';
import { readWorkspace } from '../src/workspace.js';
import { removeTemp, writeTemp } from './helpers.js';

/** An esbuild metafile shaped like the one the Angular application builder writes. */
function metafile(mainBytes: number): object {
  return {
    inputs: {},
    outputs: {
      'main-A.js': {
        bytes: mainBytes,
        entryPoint: 'src/main.ts',
        imports: [
          { path: 'chunk-SHARED.js', kind: 'import-statement' },
          { path: 'chunk-LAZY.js', kind: 'dynamic-import' },
        ],
        inputs: { 'src/main.ts': { bytesInOutput: 1000 }, 'node_modules/@angular/core/fesm2022/core.mjs': { bytesInOutput: mainBytes - 1000 } },
      },
      'chunk-SHARED.js': { bytes: 50000, imports: [], inputs: { 'node_modules/rxjs/dist/esm/index.js': { bytesInOutput: 50000 } } },
      // A lazy route is an entry point too; only the dynamic import marks it lazy.
      'chunk-LAZY.js': { bytes: 3000, entryPoint: 'src/app/about.ts', imports: [{ path: 'chunk-SHARED.js', kind: 'import-statement' }], inputs: {} },
      'polyfills-B.js': { bytes: 100, entryPoint: 'angular:polyfills:angular:polyfills', imports: [], inputs: { 'angular:polyfills:angular:polyfills': { bytesInOutput: 100 } } },
      'styles-C.css': { bytes: 400, entryPoint: 'angular:styles/global:styles', imports: [], inputs: {} },
      // Component CSS without an entry point is inlined by Angular, not loaded.
      'app-D.css': { bytes: 9999, imports: [], inputs: {} },
      'main-A.js.map': { bytes: 123456, imports: [], inputs: {} },
    },
  };
}

describe('parseStats', () => {
  it('counts the initial bundle like the CLI: entry points not loaded dynamically, and their static imports', () => {
    const stats = parseStats(metafile(200000))!;
    expect(stats).toMatchObject({ format: 'esbuild', initialBytes: 200000 + 50000 + 100 + 400, lazyChunks: 1, lazyBytes: 3000, largestLazy: { file: 'chunk-LAZY.js', bytes: 3000 } });
    expect(stats.initialByPackage).toEqual([
      { name: '@angular/core', bytes: 199000 },
      { name: 'rxjs', bytes: 50000 },
      { name: '(your code)', bytes: 1000 },
    ]);
  });

  it('reads webpack stats from the browser builder', () => {
    const stats = parseStats({
      assets: [
        { name: 'main.js', size: 300000 },
        { name: 'polyfills.js', size: 40000 },
        { name: 'styles.css', size: 5000 },
        { name: '123.js', size: 7000 },
      ],
      chunks: [
        { id: 'main', initial: true, files: ['main.js'] },
        { id: 'polyfills', initial: true, files: ['polyfills.js'] },
        { id: 'styles', initial: true, files: ['styles.css'] },
        { id: 123, initial: false, files: ['123.js'] },
      ],
      modules: [
        { name: './node_modules/moment/moment.js', size: 170000, chunks: ['main'] },
        { name: './src/app/lazy.ts', size: 7000, chunks: [123] },
      ],
    })!;
    expect(stats).toMatchObject({ format: 'webpack', initialBytes: 345000, lazyChunks: 1, lazyBytes: 7000 });
    expect(stats.initialByPackage).toEqual([{ name: 'moment', bytes: 170000 }]);
  });

  it('ignores JSON that is neither', () => {
    expect(parseStats({ name: 'x' })).toBeUndefined();
  });
});

describe('parseSize', () => {
  it('reads budgets in binary units, as Angular does', () => {
    expect(parseSize('500kB')).toBe(512000);
    expect(parseSize('1mb')).toBe(1048576);
    expect(parseSize('2.5 MB')).toBe(2621440);
    expect(parseSize('300')).toBe(300);
    expect(parseSize('lots')).toBeUndefined();
  });
});

describe('the bundle check', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  /** A CLI app whose production budget is 300kB / 600kB, built with --stats-json into the default folder. */
  function builtApp(mainBytes: number): string {
    return writeTemp({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '~22.0.0' } }),
      'angular.json': JSON.stringify({
        projects: {
          shop: {
            root: '',
            projectType: 'application',
            architect: {
              build: {
                builder: '@angular/build:application',
                options: {},
                configurations: { production: { budgets: [{ type: 'initial', maximumWarning: '300kB', maximumError: '600kB' }] } },
              },
            },
          },
        },
      }),
      'dist/shop/browser-stats.json': JSON.stringify(metafile(mainBytes)),
      'src/main.ts': 'export {};',
    });
  }

  it('finds browser-stats.json in the default output folder and reads the budget', () => {
    root = builtApp(100000);
    const [stats] = readBundleStats(readWorkspace(root, []));
    expect(stats).toMatchObject({ project: 'shop', file: 'dist/shop/browser-stats.json', budget: { warning: 307200, error: 614400 } });
  });

  it('grades against the budget: good under it, fair over the warning, poor over the error', async () => {
    const grade = async (mainBytes: number) => {
      root = builtApp(mainBytes);
      const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'bundle')!;
      removeTemp(root);
      return check;
    };
    expect((await grade(100000)).grade).toBe('good');
    const fair = await grade(300000);
    expect(fair.grade).toBe('fair');
    expect(fair.findings[0]).toMatchObject({ severity: 'medium', message: 'The initial bundle is 350.5 kB, over its warning budget of 300 kB' });
    const poor = await grade(700000);
    expect(poor.grade).toBe('poor');
    expect(poor.findings[0]!.detail).toContain('Largest parts: @angular/core 699.0 kB, rxjs 50.0 kB, (your code) 1.0 kB.');
    root = '';
  });

  it('is info without stats, with the command to produce them', async () => {
    root = writeTemp({ 'package.json': '{}', 'src/a.ts': 'export const a = 1;' });
    const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'bundle')!;
    expect(check.grade).toBe('info');
    expect(check.findings[0]!.message).toContain('ng build --stats-json');
  });
});
