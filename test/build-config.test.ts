import { runCheckup } from '../src/index.js';
import { readDuplicatePackages } from '../src/lockfile.js';
import { removeTemp, writeTemp } from './helpers.js';

const angularJson = (build: Record<string, unknown>): string => JSON.stringify({ version: 1, projects: { app: { root: '', projectType: 'application', architect: { build } } } });

describe('production build settings', () => {
  let root = '';
  afterEach(() => root && removeTemp(root));

  const version = async (build: Record<string, unknown>) => {
    root = writeTemp({ 'package.json': JSON.stringify({ dependencies: { '@angular/core': '22.0.0' } }), 'angular.json': angularJson(build), 'src/main.ts': '' });
    const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'version')!;
    return { check, messages: check.findings.map((finding) => finding.message).filter((message) => message.startsWith('Production build')) };
  };

  it('reads the production configuration over the options, and only what is written', async () => {
    const { check, messages } = await version({
      builder: '@angular-devkit/build-angular:browser',
      options: { sourceMap: true, aot: false },
      configurations: { production: { optimization: false, buildOptimizer: false, outputHashing: 'none' } },
    });
    expect(messages).toEqual([
      'Production build without optimization',
      'Production build without ahead-of-time compilation',
      'Production build with the build optimizer off',
      'Production build publishes its source maps',
      'Production build without budgets',
      'Production build without hashed file names',
    ]);
    expect(check.findings.find((finding) => finding.message === 'Production build without optimization')).toMatchObject({ severity: 'medium', files: [{ path: 'angular.json' }] });
    expect(check.measures).toContainEqual({ id: 'production-build-issues', label: 'Production build settings that cost users', value: 6 });
  });

  it('is quiet on a generated production configuration, and grades nothing', async () => {
    const generated = {
      builder: '@angular/build:application',
      options: { browser: 'src/main.ts' },
      configurations: {
        production: { budgets: [{ type: 'initial', maximumWarning: '500kB', maximumError: '1MB' }], outputHashing: 'all' },
        development: { optimization: false, sourceMap: true },
      },
    };
    const clean = await version(generated);
    expect(clean.messages).toEqual([]);
    expect(clean.check.measures).toContainEqual({ id: 'production-build-issues', label: 'Production build settings that cost users', value: 0 });
    removeTemp(root);
    const hidden = await version({ ...generated, configurations: { production: { ...generated.configurations.production, sourceMap: { scripts: true, hidden: true } } } });
    expect(hidden.messages).toEqual([]);
    expect(hidden.check.grade).toBe(clean.check.grade);
  });

  it('says nothing without a production configuration, since what ng build uses cannot be told', async () => {
    const { check, messages } = await version({ builder: '@angular/build:application', options: { optimization: false } });
    expect(messages).toEqual([]);
    expect(check.measures?.some((measure) => measure.id === 'production-build-issues')).toBe(false);
  });
});

describe('packages locked in more than one major', () => {
  let root = '';
  afterEach(() => root && removeTemp(root));

  it('reads the whole npm tree, without what only development needs', () => {
    root = writeTemp({
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/rxjs': { version: '7.8.1' },
          'node_modules/@ledgerhq/devices/node_modules/rxjs': { version: '6.6.7' },
          'node_modules/@schematics/angular/node_modules/rxjs': { version: '5.5.12', dev: true },
          'node_modules/@angular/core': { version: '22.0.0' },
          'node_modules/old-lib/node_modules/@angular/core': { version: '15.2.0' },
          'node_modules/tslib': { version: '2.6.0' },
          'node_modules/x/node_modules/tslib': { version: '1.14.1' },
          'node_modules/@angular/cli': { version: '22.0.0', dev: true },
        },
      }),
    });
    expect(readDuplicatePackages(root, {})).toEqual({
      file: 'package-lock.json',
      packages: [
        { name: '@angular/core', versions: ['15.2.0', '22.0.0'] },
        { name: 'rxjs', versions: ['6.6.7', '7.8.1'] },
      ],
    });
  });

  it('walks yarn.lock from the production dependencies, so a CLI tool\'s copy is not counted', () => {
    root = writeTemp({
      'yarn.lock': [
        '# yarn lockfile v1',
        '',
        'app-lib@^1.0.0:',
        '  version "1.0.0"',
        '  dependencies:',
        '    rxjs "^6.6.0"',
        '',
        'inquirer@^6.2.2:',
        '  version "6.5.2"',
        '  dependencies:',
        '    rxjs "^6.4.0"',
        '',
        'rxjs@^6.4.0, rxjs@^6.6.0:',
        '  version "6.6.7"',
        '',
        'rxjs@^7.8.0:',
        '  version "7.8.1"',
        '',
      ].join('\n'),
    });
    expect(readDuplicatePackages(root, { rxjs: '^7.8.0', 'app-lib': '^1.0.0' })!.packages).toEqual([{ name: 'rxjs', versions: ['6.6.7', '7.8.1'] }]);
    expect(readDuplicatePackages(root, { rxjs: '^7.8.0' })!.packages).toEqual([]);
  });

  it('reads Berry, and says nothing for pnpm or without a lockfile', () => {
    root = writeTemp({
      'yarn.lock': ['__metadata:', '  version: 6', '', '"rxjs@npm:^7.8.0":', '  version: 7.8.1', '', '"lib@npm:^2.0.0":', '  version: 2.0.0', '  dependencies:', '    rxjs: "npm:^6.0.0"', '', '"rxjs@npm:^6.0.0":', '  version: 6.6.7', ''].join('\n'),
    });
    expect(readDuplicatePackages(root, { rxjs: '^7.8.0', lib: '^2.0.0' })!.packages).toEqual([{ name: 'rxjs', versions: ['6.6.7', '7.8.1'] }]);
    removeTemp(root);
    root = writeTemp({ 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'yarn.lock': '' });
    expect(readDuplicatePackages(root, {})).toBeUndefined();
    removeTemp(root);
    root = writeTemp({});
    expect(readDuplicatePackages(root, {})).toBeUndefined();
  });
});
