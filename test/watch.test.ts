import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAnalysisCache } from '../src/cache.js';
import { buildContext, runCheckup } from '../src/index.js';
import { describeProgress, isRelevantChange, watchCheckup } from '../src/watch.js';
import { removeTemp, writeTemp } from './helpers.js';

const APP = {
  'package.json': JSON.stringify({ dependencies: { '@angular/core': '~20.0.0' } }),
  'src/app/a.component.ts': "import { Component } from '@angular/core';\n@Component({ selector: 'a', template: '' })\nexport class A {}\n",
  'src/app/b.ts': 'export const b = 1;\n',
};

describe('isRelevantChange', () => {
  it('reacts to sources, templates and configs, not to caches and build output', () => {
    expect(isRelevantChange('src/app/a.ts')).toBe(true);
    expect(isRelevantChange('src/app/a.html')).toBe(true);
    expect(isRelevantChange('package.json')).toBe(true);
    expect(isRelevantChange('pnpm-lock.yaml')).toBe(true);
    expect(isRelevantChange('src/app/a.scss')).toBe(false);
    expect(isRelevantChange('node_modules/x/index.d.ts')).toBe(false);
    expect(isRelevantChange('apps/web/dist/main.ts')).toBe(false);
    expect(isRelevantChange('.angular/cache/x.json')).toBe(false);
    expect(isRelevantChange('.nx/workspace-data/file-map.json')).toBe(false);
  });
});

describe('the analysis cache', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  it('re-parses only the files that changed, and forgets deleted ones', async () => {
    root = writeTemp(APP);
    const cache = createAnalysisCache();
    const first = await buildContext(root, { offline: true, cache });
    const path = join(root, 'src/app/b.ts');
    writeFileSync(path, 'export const b: any = 1;\n');
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    const second = await buildContext(root, { offline: true, cache });
    const byPath = (context: typeof first, name: string) => context.sources.find((file) => file.path.endsWith(name));
    expect(byPath(second, 'a.component.ts')).toBe(byPath(first, 'a.component.ts'));
    expect(byPath(second, 'b.ts')).not.toBe(byPath(first, 'b.ts'));
    expect(byPath(second, 'b.ts')!.anyLines).toEqual([1]);
    expect(second.deprecations).toBe(first.deprecations);
  });
});

describe('describeProgress', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  it('compares the score and the measures with the first run', async () => {
    root = writeTemp(APP);
    const start = await runCheckup(root, { offline: true });
    writeFileSync(join(root, 'src/app/b.ts'), 'export const b: any = 1;\nexport const c: any = 2;\n');
    const now = await runCheckup(root, { offline: true });
    const text = describeProgress(start, now);
    expect(text).toMatch(/^Score \d+ -> \d+ \(/);
    expect(text).toContain('up   Explicit any');
    expect(describeProgress(start, start)).toMatch(/\(no change since the watch started\)$/);
  });
});

describe('watchCheckup', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  it('runs once at start and again after a relevant change, never for an ignored one', async () => {
    root = writeTemp(APP);
    let runs = 0;
    let notify: () => void = () => undefined;
    const stop = watchCheckup({
      root,
      debounceMs: 50,
      ignorePaths: [join(root, 'report.json')],
      run: async () => {
        runs++;
        notify();
      },
    });
    const nextRun = () => new Promise<void>((resolve) => (notify = resolve));
    expect(runs).toBe(1);
    // Give the watcher a moment to attach before changing anything.
    await new Promise((resolve) => setTimeout(resolve, 150));
    writeFileSync(join(root, 'report.json'), '{}');
    writeFileSync(join(root, 'src/app/style.scss'), '');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runs).toBe(1);
    const changed = nextRun();
    writeFileSync(join(root, 'src/app/b.ts'), 'export const b = 2;\n');
    await changed;
    expect(runs).toBe(2);
    await stop();
  });
});
