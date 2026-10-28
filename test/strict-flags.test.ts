import { join } from 'node:path';
import { runCheckup } from '../src/index.js';
import type { Finding, Report } from '../src/types.js';
import { locateStrictFlags, reportPath } from '../src/workspace.js';
import { fixture, removeTemp, writeTemp } from './helpers.js';

/** The type-safety finding whose message names `flag`. */
function flagFinding(report: Report, flag: string): Finding | undefined {
  return report.checks.find((check) => check.id === 'type-safety')?.findings.find((finding) => finding.message === `\`${flag}\` is off`);
}

/** An Angular 17 CLI app whose tsconfigs are given, so `strictTemplates` is off by default and TypeScript 5 leaves `strict` off. */
function app(tsconfigs: Record<string, string>, folder = ''): Record<string, string> {
  const prefix = folder ? `${folder}/` : '';
  return {
    [`${prefix}package.json`]: JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^17.0.0', typescript: '~5.4.0' } }),
    [`${prefix}angular.json`]: JSON.stringify({
      projects: { web: { root: '', projectType: 'application', architect: { build: { builder: '@angular/build:application', options: { browser: 'src/main.ts', tsConfig: 'tsconfig.app.json' } } } } },
    }),
    [`${prefix}src/main.ts`]: 'export {};\n',
    ...Object.fromEntries(Object.entries(tsconfigs).map(([name, content]) => [`${prefix}${name}`, content])),
  };
}

describe('strictness findings point at the tsconfig that decides them', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) removeTemp(root);
    root = undefined;
  });

  it('follows extends to the `strict: false` line, and puts an unwritten strictTemplates on the app tsconfig', async () => {
    const report = await runCheckup(fixture('legacy-app'), { offline: true });
    expect(flagFinding(report, 'strictNullChecks')?.files).toEqual([{ path: 'tsconfig.json', line: 2 }]);
    expect(flagFinding(report, 'noImplicitAny')?.files).toEqual([{ path: 'tsconfig.json', line: 2 }]);
    expect(flagFinding(report, 'strictTemplates')?.files).toEqual([{ path: 'tsconfig.app.json' }]);
  });

  it('prefers the flag itself over `strict`, wherever in the chain each is written', async () => {
    root = writeTemp(
      app({
        'tsconfig.json': '{\n  "compilerOptions": {\n    "strictNullChecks": false\n  }\n}\n',
        'tsconfig.app.json': '{\n  "extends": "./tsconfig.json",\n  "compilerOptions": {\n    "strict": true\n  },\n  "angularCompilerOptions": {\n    "strictTemplates": false\n  }\n}\n',
      }),
    );
    const report = await runCheckup(root, { offline: true });
    expect(flagFinding(report, 'strictNullChecks')?.files).toEqual([{ path: 'tsconfig.json', line: 3 }]);
    expect(flagFinding(report, 'noImplicitAny')).toBeUndefined();
    expect(flagFinding(report, 'strictTemplates')?.files).toEqual([{ path: 'tsconfig.app.json', line: 7 }]);
  });

  it('reports paths from the analysed root when the workspace is in a subfolder', async () => {
    root = writeTemp({ 'setup.py': '', ...app({ 'tsconfig.app.json': '{\n  "compilerOptions": { "strict": false }\n}\n' }, 'web') });
    const report = await runCheckup(root, { offline: true });
    expect(report.project.workspaceFolder).toBe('web');
    expect(flagFinding(report, 'strictNullChecks')?.files).toEqual([{ path: 'web/tsconfig.app.json', line: 2 }]);
  });

  it('gives no location for a flag decided outside the analysed root', () => {
    root = writeTemp({ 'shared/tsconfig.base.json': '{ "compilerOptions": { "strict": false } }', 'app/tsconfig.app.json': '{ "extends": "../shared/tsconfig.base.json" }' });
    const flags = locateStrictFlags(join(root, 'app/tsconfig.app.json'));
    expect(flags.strictNullChecks).toEqual({ file: join(root, 'shared/tsconfig.base.json'), line: 1 });
    expect(reportPath({ root: join(root, 'app') }, flags.strictNullChecks.file)).toBeUndefined();
  });
});
