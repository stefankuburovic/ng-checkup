import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baselineIncreases, compareWithBaseline, createBaseline, readBaseline, serializeBaseline, type Baseline } from '../src/baseline.js';
import { planInit } from '../src/init.js';
import { runCheckup } from '../src/index.js';
import type { Report } from '../src/types.js';
import { fixture, removeTemp, writeTemp } from './helpers.js';

/** A report with the given measures under one check, and an info check without any. */
function reportWith(measures: Record<string, number>): Report {
  return {
    tool: { name: 'ng-checkup', version: '0.3.0' },
    generatedAt: '2026-10-20T10:00:00.000Z',
    root: '/repo',
    project: { name: 'app', kind: 'angular-cli', sourceFiles: 1, templateFiles: 0, linesOfCode: 1 },
    checks: [
      { id: 'type-safety', title: 'Type safety', grade: 'fair', summary: '', metrics: [], findings: [], measures: Object.entries(measures).map(([id, value]) => ({ id, label: id, value })) },
      { id: 'testing', title: 'Testing', grade: 'info', summary: '', metrics: [], findings: [] },
    ],
    durationMs: 1,
  };
}

describe('createBaseline and compareWithBaseline', () => {
  it('records every measure under check.measure with sorted keys', () => {
    const baseline = createBaseline(reportWith({ 'non-null-assertions': 4, 'explicit-any': 9 }));
    expect(baseline).toEqual({ version: 1, tool: 'ng-checkup 0.3.0', updated: '2026-10-20', measures: { 'type-safety.explicit-any': 9, 'type-safety.non-null-assertions': 4 } });
    expect(Object.keys(JSON.parse(serializeBaseline(baseline)).measures)).toEqual(['type-safety.explicit-any', 'type-safety.non-null-assertions']);
  });

  it('splits changes into regressions and improvements, and only notes measures the baseline lacks', () => {
    const baseline: Baseline = { version: 1, tool: '', updated: '', measures: { 'type-safety.explicit-any': 9, 'type-safety.non-null-assertions': 4, 'testing.untested-files': 30 } };
    const comparison = compareWithBaseline(reportWith({ 'explicit-any': 11, 'non-null-assertions': 2, 'ts-suppressions': 1 }), baseline, 'b.json');
    expect(comparison.regressions).toEqual([{ key: 'type-safety.explicit-any', check: 'Type safety', label: 'explicit-any', before: 9, after: 11 }]);
    expect(comparison.improvements.map((delta) => delta.key)).toEqual(['type-safety.non-null-assertions']);
    expect(comparison.added).toEqual(['type-safety.ts-suppressions']);
    // testing.untested-files was not measured this time (info), which is neither better nor worse.
  });

  it('lets a baseline only go down unless forced', () => {
    const before: Baseline = { version: 1, tool: '', updated: '', measures: { a: 3, b: 5 } };
    expect(baselineIncreases(before, { ...before, measures: { a: 2, b: 6, c: 1 } })).toEqual([{ key: 'b', before: 5, after: 6 }]);
    expect(baselineIncreases(undefined, before)).toEqual([]);
  });

  it('refuses a file that is not a baseline, so CI cannot compare against nothing', () => {
    const root = writeTemp({ 'ok.json': serializeBaseline({ version: 1, tool: 't', updated: 'd', measures: { a: 1 } }), 'bad.json': '{"version":2,"measures":{}}', 'broken.json': '{' });
    try {
      expect(readBaseline(join(root, 'ok.json'))?.measures).toEqual({ a: 1 });
      expect(readBaseline(join(root, 'missing.json'))).toBeUndefined();
      expect(() => readBaseline(join(root, 'bad.json'))).toThrow('is not an ng-checkup baseline');
      expect(() => readBaseline(join(root, 'broken.json'))).toThrow('is not valid JSON');
    } finally {
      removeTemp(root);
    }
  });

  it('measures only what the code controls, not the gap to the latest Angular', async () => {
    const keys = Object.keys(createBaseline(await runCheckup(fixture('legacy-app'), { offline: true })).measures);
    expect(keys).toContain('circular-deps.files-in-cycles');
    expect(keys).toContain('version.end-of-life-packages');
    expect(keys.some((key) => key.includes('majors'))).toBe(false);
  });
});

describe('init with a baseline', () => {
  it('writes the baseline and switches CI to --fail-on regression', () => {
    const files: Record<string, string> = { 'package.json': '{"dependencies":{"@angular/core":"^15.0.0"}}', 'angular.json': '{}', '.github/x': '' };
    const plan = planInit({ read: (path) => files[path], exists: (path) => path in files || Object.keys(files).some((key) => key.startsWith(`${path}/`)) }, { version: '0.3.0', baseline: '{"version":1}\n' });
    expect(plan.changes.find((change) => change.path === 'ng-checkup.baseline.json')?.content).toBe('{"version":1}\n');
    expect(plan.changes.find((change) => change.path.endsWith('.yml'))?.content).toContain('--fail-on regression');
  });
});

describe('the baseline workflow through the built CLI', () => {
  const cli = join(fixture('..'), '..', 'dist', 'cli.js');
  let root = '';
  afterEach(() => removeTemp(root));
  /** The CLI; a checkup run gets --no-color, the baseline command takes no such option. */
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, ...(args[0] === 'baseline' ? [] : ['--no-color'])], { encoding: 'utf8' });

  it('fails CI only when a number gets worse, and only lets the baseline go down', () => {
    root = writeTemp({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^20.0.0' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'src/a.ts': 'export const a: any = 1;\nexport const b: any = 2;\n',
    });

    expect(run(root, '--offline', '--fail-on', 'regression').status).toBe(2);

    const created = run('baseline', root);
    expect(created.status).toBe(0);
    expect(created.stdout).toContain('Baseline written');
    expect(readBaseline(join(root, 'ng-checkup.baseline.json'))?.measures['type-safety.explicit-any']).toBe(2);
    expect(run(root, '--offline', '--fail-on', 'regression').status).toBe(0);

    writeFileSync(join(root, 'src/a.ts'), 'export const a: any = 1;\nexport const b: any = 2;\nexport const c: any = 3;\n');
    const worse = run(root, '--offline', '--fail-on', 'regression');
    expect(worse.status).toBe(1);
    expect(worse.stdout).toContain('1 worse');
    expect(worse.stdout).toContain('Explicit any in application code 2 → 3');
    const refused = run('baseline', root);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('type-safety.explicit-any: 2 -> 3');
    expect(run('baseline', root, '--force').status).toBe(0);

    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
    const better = run(root, '--offline', '--fail-on', 'regression', '--report', join(root, 'r.md'));
    expect(better.status).toBe(0);
    expect(better.stdout).toContain('1 better');
    expect(readFileSync(join(root, 'r.md'), 'utf8')).toContain('## Compared with the baseline');
    expect(run('baseline', root).stdout).toContain('lowered type-safety.explicit-any: 3 -> 0');
    expect(existsSync(join(root, 'ng-checkup.baseline.json'))).toBe(true);
  });
});
