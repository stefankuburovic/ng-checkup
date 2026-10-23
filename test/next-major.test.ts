import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCheckup } from '../src/index.js';
import { nextMajorChanges } from '../src/next-major.js';
import { scanSourceFile } from '../src/scan.js';
import { resolveWorkspace } from '../src/workspace.js';
import { removeTemp, writeTemp } from './helpers.js';

/** A cached typings entry as `packageTypings` leaves it: `package.json` plus `.d.ts` files. */
function cachedPackage(cache: string, name: string, version: string, dts: string): void {
  const directory = join(cache, 'packages', `${name.replace('/', '+')}@${version}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, typings: 'index.d.ts' }));
  writeFileSync(join(directory, 'index.d.ts'), dts);
}

// Real Angular typings always deprecate something; without one, the deprecated-APIs check reports the typings as unreadable.
const CORE_21 = `
/** @deprecated 19.0 Unused here. */
export declare class Old {}
export declare class Keep {}
export declare class Gone {}
export declare function soonGone(): void;
export declare enum ChangeDetectionStrategy { OnPush = 0, Default = 1 }
`;

const CORE_22 = `
export declare class Keep {}
/** @deprecated 22.0 Use \`replacement()\` instead, it covers both cases. */
export declare function soonGone(): void;
export declare enum ChangeDetectionStrategy {
  OnPush = 0,
  /** @deprecated 22.0 Use \`Eager\` instead, OnPush is the default now. */
  Default = 1,
  Eager = 1,
}
`;

describe('what the next major breaks', () => {
  let root: string | undefined;
  let cache: string | undefined;
  const previousCache = process.env['NG_CHECKUP_CACHE'];
  afterEach(() => {
    if (root) removeTemp(root);
    if (cache) removeTemp(cache);
    root = cache = undefined;
    if (previousCache === undefined) delete process.env['NG_CHECKUP_CACHE'];
    else process.env['NG_CHECKUP_CACHE'] = previousCache;
  });

  async function checkup(plan = false) {
    cache = writeTemp({});
    process.env['NG_CHECKUP_CACHE'] = cache;
    cachedPackage(cache, '@angular/core', '21.0.0', CORE_21);
    cachedPackage(cache, '@angular/core', '22.0.0', CORE_22);
    root = writeTemp({
      'package.json': JSON.stringify({ name: 'shop', dependencies: { '@angular/core': '^21.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@angular/core': { version: '21.0.0' } } }),
      'src/app.ts': [
        "import { ChangeDetectionStrategy, Gone, Keep, soonGone } from '@angular/core';",
        'export const strategy = ChangeDetectionStrategy.Default;',
        'export const things = [Gone, Keep, soonGone];',
      ].join('\n'),
      'src/other.ts': "import { Gone } from '@angular/core';\nexport const again = Gone;\n",
    });
    // Offline: the 22 typings come from the cache, as an earlier online run would have left them.
    return runCheckup(root, { offline: true, plan });
  }

  it('names an import the next major no longer exports, and what it newly deprecates, from its own typings', async () => {
    const report = await checkup();
    const check = report.checks.find((entry) => entry.id === 'deprecated-apis');
    const removed = check?.findings.find((finding) => finding.message.includes('removed in Angular 22'));
    expect(removed?.severity).toBe('high');
    expect(removed?.message).toBe('1 imported API removed in Angular 22, imported in 2 files');
    expect(removed?.detail).toContain('`Gone` from @angular/core (2 files)');
    expect(removed?.files?.map((file) => file.path).sort()).toEqual(['src/app.ts', 'src/other.ts']);

    const deprecated = check?.findings.find((finding) => finding.message.includes('deprecated in Angular 22'));
    expect(deprecated?.severity).toBe('low');
    expect(deprecated?.message).toBe('2 imported APIs deprecated in Angular 22');
    expect(deprecated?.detail).toContain('`ChangeDetectionStrategy.Default` from @angular/core (1 file): Use `Eager` instead, OnPush is the default now');
    expect(deprecated?.detail).toContain('`soonGone` from @angular/core (1 file)');
    // `Keep` is in both versions and not deprecated: not mentioned.
    expect(JSON.stringify(check?.findings)).not.toContain('`Keep`');
    expect(check?.metrics.find((metric) => metric.label === 'Angular 22')).toEqual({ label: 'Angular 22', value: '1 removed, 2 deprecated', hint: 'imports, compared with 22.0.0' });
    // The removal grades the area; the advance deprecations alone would not.
    expect(check?.grade).toBe('poor');
  });

  it('puts the removed imports into the first step of the plan', async () => {
    const report = await checkup(true);
    const step = report.plan?.steps[0];
    expect(step?.to).toBe(22);
    expect(step?.items).toContainEqual(expect.objectContaining({ title: 'Replace the import Angular 22 removes', count: 2 }));
  });

  it('compares with the registry\'s next prerelease when the project is on the latest major', async () => {
    cache = writeTemp({});
    process.env['NG_CHECKUP_CACHE'] = cache;
    cachedPackage(cache, '@angular/core', '22.0.0', CORE_21.replace('Default = 1', 'Default = 1, Eager = 1'));
    cachedPackage(cache, '@angular/core', '23.0.0-next.1', CORE_22);
    root = writeTemp({
      'package.json': JSON.stringify({ name: 'shop', dependencies: { '@angular/core': '^22.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@angular/core': { version: '22.0.0' } } }),
      'src/app.ts': "import { Gone } from '@angular/core';\nexport const x = Gone;\n",
    });
    // Only the packument is fetched: both typings are in the cache already.
    vi.stubGlobal('fetch', async (input: string | URL | Request) =>
      String(input).includes('%2Fcore') ? new Response(JSON.stringify({ 'dist-tags': { latest: '22.0.0', next: '23.0.0-next.1' }, versions: {} })) : new Response('{}', { status: 404 }),
    );
    try {
      const changes = await nextMajorChanges(resolveWorkspace(root, [], []), [scanSourceFile(root, join(root, 'src/app.ts'))], 22, false);
      expect(changes).toMatchObject({ major: 23, version: '23.0.0-next.1', prerelease: true, missing: [] });
      expect(changes?.removed.map((change) => change.name)).toEqual(['Gone']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says nothing about a next major it has no typings for', async () => {
    cache = writeTemp({});
    process.env['NG_CHECKUP_CACHE'] = cache;
    cachedPackage(cache, '@angular/core', '21.0.0', CORE_21);
    root = writeTemp({
      'package.json': JSON.stringify({ name: 'shop', dependencies: { '@angular/core': '^21.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@angular/core': { version: '21.0.0' } } }),
      'src/app.ts': "import { Gone } from '@angular/core';\nexport const x = Gone;\n",
    });
    const report = await runCheckup(root, { offline: true });
    const check = report.checks.find((entry) => entry.id === 'deprecated-apis');
    expect(check?.metrics.some((metric) => metric.label === 'Angular 22')).toBe(false);
    expect(JSON.stringify(check?.findings)).not.toContain('Angular 22');
  });
});
