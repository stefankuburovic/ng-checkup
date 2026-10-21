import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveVersion } from '../src/compatibility.js';
import { runCheckup } from '../src/index.js';
import { readLockedVersions } from '../src/lockfile.js';
import { packageTypings, readTar } from '../src/package-store.js';
import { parseRemote } from '../src/remote.js';
import { fixture, removeTemp, writeTemp } from './helpers.js';

const NAMES = ['@angular/core', 'rxjs', 'typescript'];

describe('readLockedVersions', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  it('reads npm lockfiles v3 and v1', () => {
    root = writeTemp({ 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@angular/core': { version: '15.2.10' }, 'node_modules/rxjs': { version: '7.8.1' } } }) });
    expect(readLockedVersions(root, NAMES)).toEqual({ kind: 'npm', versions: { '@angular/core': '15.2.10', rxjs: '7.8.1' } });
    removeTemp(root);
    root = writeTemp({ 'package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: { typescript: { version: '4.8.4' } } }) });
    expect(readLockedVersions(root, NAMES).versions).toEqual({ typescript: '4.8.4' });
  });

  it('reads yarn classic and Berry, picking the version locked for the declared range', () => {
    root = writeTemp({
      'yarn.lock': ['"@angular/core@^14.0.0":', '  version "14.3.0"', '', '"@angular/core@^15.0.0", "@angular/core@~15.2.0":', '  version "15.2.10"', '', 'rxjs@^7.5.0:', '  version "7.8.0"', ''].join('\n'),
    });
    expect(readLockedVersions(root, NAMES, { '@angular/core': '^15.0.0' }).versions).toEqual({ '@angular/core': '15.2.10', rxjs: '7.8.0' });
    removeTemp(root);
    root = writeTemp({ 'yarn.lock': ['__metadata:', '  version: 8', '', '"@angular/core@npm:21.2.0":', '  version: 21.2.0', '  resolution: "@angular/core@npm:21.2.0"', ''].join('\n') });
    expect(readLockedVersions(root, NAMES, { '@angular/core': '21.2.0' })).toEqual({ kind: 'yarn', versions: { '@angular/core': '21.2.0' } });
  });

  it('reads pnpm lockfiles v9 and v5', () => {
    root = writeTemp({
      'pnpm-lock.yaml': ["lockfileVersion: '9.0'", 'importers:', '  .:', '    dependencies:', "      '@angular/core':", '        specifier: ^20.0.0', '        version: 20.1.3(rxjs@7.8.2)(zone.js@0.15.1)', '      rxjs:', '        specifier: ~7.8.0', '        version: 7.8.2', ''].join('\n'),
    });
    expect(readLockedVersions(root, NAMES).versions).toEqual({ '@angular/core': '20.1.3', rxjs: '7.8.2' });
    removeTemp(root);
    root = writeTemp({ 'pnpm-lock.yaml': ['lockfileVersion: 5.4', 'dependencies:', "  '@angular/core': 15.2.10_rxjs@7.8.1", '  rxjs: 7.8.1', ''].join('\n') });
    expect(readLockedVersions(root, NAMES)).toEqual({ kind: 'pnpm', versions: { '@angular/core': '15.2.10', rxjs: '7.8.1' } });
  });
});

describe('readTar', () => {
  it('reads what the system tar writes, long names included', () => {
    const source = writeTemp({});
    const archive = writeTemp({});
    try {
      const deep = `package/${'nested-directory-name/'.repeat(6)}index.d.ts`;
      mkdirSync(join(source, deep, '..'), { recursive: true });
      writeFileSync(join(source, deep), 'export declare const a: number;\n');
      writeFileSync(join(source, 'package', 'package.json'), '{"name":"x"}');
      expect(spawnSync('tar', ['-cf', join(archive, 'x.tar'), '-C', source, 'package']).status).toBe(0);
      const files = readTar(readFileSync(join(archive, 'x.tar')));
      expect(files.get(deep)?.toString()).toBe('export declare const a: number;\n');
      expect(files.get('package/package.json')?.toString()).toBe('{"name":"x"}');
    } finally {
      removeTemp(source);
      removeTemp(archive);
    }
  });
});

describe('typings without node_modules', () => {
  const previous = process.env['NG_CHECKUP_CACHE'];
  let cache = '';
  let root = '';
  afterEach(() => {
    removeTemp(root);
    removeTemp(cache);
    if (previous === undefined) delete process.env['NG_CHECKUP_CACHE'];
    else process.env['NG_CHECKUP_CACHE'] = previous;
  });

  it('reads the deprecations of the locked version from the cache, offline, and says where the version came from', async () => {
    cache = writeTemp({});
    process.env['NG_CHECKUP_CACHE'] = cache;
    for (const name of ['core', 'common']) cpSync(fixture(`deprecations-app/node_modules/@angular/${name}`), join(cache, 'packages', `@angular+${name}@22.0.3`), { recursive: true });
    root = writeTemp({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^22.0.0', '@angular/common': '^22.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@angular/core': { version: '22.0.3' }, 'node_modules/@angular/common': { version: '22.0.3' } } }),
      'src/main.ts': "import { APP_INITIALIZER } from '@angular/core';\nexport const providers = [APP_INITIALIZER];\n",
    });
    const report = await runCheckup(root, { offline: true });
    const deprecated = report.checks.find((check) => check.id === 'deprecated-apis')!;
    expect(deprecated.grade).not.toBe('info');
    expect(deprecated.findings[0]?.message).toContain('APP_INITIALIZER');
    expect(report.checks.find((check) => check.id === 'version')!.metrics).toContainEqual(expect.objectContaining({ label: 'Installed', value: '22.0.3', hint: 'package-lock.json' }));
  });

  it('downloads nothing offline when the cache is empty, and says what is missing', async () => {
    cache = writeTemp({});
    process.env['NG_CHECKUP_CACHE'] = cache;
    expect(await packageTypings('@angular/core', '22.0.3', true)).toBeUndefined();
    root = writeTemp({ 'package.json': JSON.stringify({ dependencies: { '@angular/core': '22.0.3' } }), 'src/main.ts': "import { inject } from '@angular/core';\nexport const x = inject;\n" });
    const deprecated = (await runCheckup(root, { offline: true })).checks.find((check) => check.id === 'deprecated-apis')!;
    expect(deprecated.grade).toBe('info');
    expect(deprecated.findings[0]?.detail).toContain('Not available: @angular/core.');
  });
});

describe('resolveVersion', () => {
  const packument = { latest: '3.0.0', versions: { '1.0.0': {}, '1.4.2': {}, '2.0.0-rc.1': {}, '2.1.0': {}, '3.0.0': {} } };
  it('takes an exact version as is and the highest stable match of a range', async () => {
    expect(await resolveVersion('x', '1.0.0', packument)).toBe('1.0.0');
    expect(await resolveVersion('x', '^1.0.0', packument)).toBe('1.4.2');
    expect(await resolveVersion('x', '>=2.0.0', packument)).toBe('3.0.0');
    expect(await resolveVersion('x', '^4.0.0', packument)).toBeUndefined();
  });
});

describe('parseRemote', () => {
  it('recognises shorthands, page URLs and git URLs, and leaves paths alone', () => {
    expect(parseRemote('github:angular/angular-cli')).toEqual({ url: 'https://github.com/angular/angular-cli.git', label: 'github.com/angular/angular-cli' });
    expect(parseRemote('gitlab:group/app#v2.1.0')).toEqual({ url: 'https://gitlab.com/group/app.git', ref: 'v2.1.0', label: 'gitlab.com/group/app' });
    expect(parseRemote('https://github.com/nrwl/nx-examples/tree/develop')).toEqual({ url: 'https://github.com/nrwl/nx-examples.git', ref: 'develop', label: 'github.com/nrwl/nx-examples' });
    expect(parseRemote('https://github.com/a/b.git#57eeb6a')).toMatchObject({ url: 'https://github.com/a/b.git', ref: '57eeb6a' });
    expect(parseRemote('git@gitlab.example.com:team/app.git')).toMatchObject({ label: 'gitlab.example.com/team/app' });
    expect(parseRemote('../my-app')).toBeUndefined();
    expect(parseRemote('github')).toBeUndefined();
  });
});
