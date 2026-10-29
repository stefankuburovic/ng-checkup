import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baselineDecreases, baselineIncreases, baselineMeasures, compareWithBaseline, createBaseline, measuresOf, readBaseline, serializeBaseline, type Baseline } from '../src/baseline.js';
import { runCheckup } from '../src/index.js';
import { fixture, nxWorkspace, removeTemp, writeTemp } from './helpers.js';

/** The admin app's module with `count` explicit `any` fields; the fixture's own has two. */
function adminModule(count: number): string {
  const fields = Array.from({ length: count }, (_, index) => `f${index}: any;`).join(' ');
  return `import { Component, NgModule } from '@angular/core';\n@Component({ selector: 'admin', template: '<p *ngIf="f0"></p>' })\nexport class AdminComponent { ${fields} }\n@NgModule({ declarations: [AdminComponent] })\nexport class AppModule {}\n`;
}

describe('per-project baselines', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  it('records one entry per project row, with the code checks only and sorted keys', async () => {
    root = nxWorkspace();
    const baseline = createBaseline(await runCheckup(root, { offline: true }));
    // shop-e2e imports nothing from Angular, so it has no row and no entry.
    expect(Object.keys(baseline.projects ?? {})).toEqual(['admin', 'shop', 'ui']);
    const admin = baseline.projects!['admin']!;
    expect(admin['type-safety.explicit-any']).toBe(2);
    expect(baseline.projects!['shop']!['type-safety.explicit-any']).toBe(0);
    // The Angular version and the packages belong to the workspace, not to a project.
    expect(Object.keys(admin).some((key) => key.startsWith('version.') || key.startsWith('dependencies.'))).toBe(false);
    expect(Object.keys(admin)).toEqual([...Object.keys(admin)].sort());
    expect(JSON.parse(serializeBaseline(baseline)).projects.admin).toEqual(admin);
  });

  it('gives a --project run the same numbers as its row, so the two can be compared', async () => {
    root = nxWorkspace();
    const workspace = await runCheckup(root, { offline: true });
    for (const name of ['admin', 'shop', 'ui']) {
      const row = workspace.projects!.find((entry) => entry.name === name)!;
      const run = measuresOf(await runCheckup(root, { offline: true, project: name }));
      const shared = Object.fromEntries(Object.keys(row.measures).map((key) => [key, run.get(key)?.value]));
      expect(shared).toEqual(row.measures);
    }
  });

  it('compares a --project run with its entry, leaving the shared measures as added', async () => {
    root = nxWorkspace();
    const baseline = createBaseline(await runCheckup(root, { offline: true }));
    writeFileSync(join(root, 'apps/admin/src/app.module.ts'), adminModule(3));
    const comparison = compareWithBaseline(await runCheckup(root, { offline: true, project: 'admin' }), baseline, 'b.json', 'admin');
    expect(comparison.regressions.map((delta) => [delta.key, delta.before, delta.after])).toEqual([['type-safety.explicit-any', 2, 3]]);
    expect(comparison.added.every((key) => key.startsWith('version.') || key.startsWith('dependencies.'))).toBe(true);
    // The shop's numbers did not move, so a shop run is clean although admin got worse.
    expect(compareWithBaseline(await runCheckup(root, { offline: true, project: 'shop' }), baseline, 'b.json', 'shop').regressions).toEqual([]);
  });

  it('holds every project to the only-goes-down rule, and ignores a project only one side knows', () => {
    const previous: Baseline = { version: 1, tool: '', updated: '', measures: { a: 5 }, projects: { admin: { a: 3 }, shop: { a: 2 } } };
    // Code moved from shop to admin: the workspace total stays at 5, admin's own number rises.
    const next: Baseline = { version: 1, tool: '', updated: '', measures: { a: 5 }, projects: { admin: { a: 4 }, shop: { a: 1 }, ui: { a: 9 } } };
    expect(baselineIncreases(previous, next)).toEqual([{ key: 'admin:a', before: 3, after: 4 }]);
    expect(baselineDecreases(previous, next)).toEqual([{ key: 'shop:a', before: 2, after: 1 }]);
    expect(baselineMeasures(next, 'ui')).toEqual({ a: 9 });
    expect(baselineMeasures(next, 'nope')).toBeUndefined();
    expect(baselineMeasures(next)).toEqual({ a: 5 });
  });

  it('reads a baseline without projects as before, and refuses a malformed projects entry', () => {
    root = writeTemp({
      'old.json': serializeBaseline({ version: 1, tool: 't', updated: 'd', measures: { a: 1 } }),
      'bad.json': JSON.stringify({ version: 1, measures: {}, projects: { admin: { a: 'many' } } }),
    });
    expect(readBaseline(join(root, 'old.json'))).toEqual({ version: 1, tool: 't', updated: 'd', measures: { a: 1 } });
    expect(() => readBaseline(join(root, 'bad.json'))).toThrow('is not an ng-checkup baseline');
  });
});

describe('--project --fail-on regression through the built CLI', { timeout: 30_000 }, () => {
  const cli = join(fixture('..'), '..', 'dist', 'cli.js');
  let root = '';
  afterEach(() => removeTemp(root));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, ...(args[0] === 'baseline' ? [] : ['--no-color'])], { encoding: 'utf8' });
  const baselinePath = () => join(root, 'ng-checkup.baseline.json');

  it("fails one project's run only on its own numbers", () => {
    root = nxWorkspace();
    expect(run(root, '--offline', '--project', 'admin', '--fail-on', 'regression').status).toBe(2);

    const created = run('baseline', root);
    expect(created.status).toBe(0);
    expect(created.stdout).toContain('3 projects');
    expect(run(root, '--offline', '--project', 'admin', '--fail-on', 'regression').status).toBe(0);

    writeFileSync(join(root, 'apps/admin/src/app.module.ts'), adminModule(3));
    const worse = run(root, '--offline', '--project', 'admin', '--fail-on', 'regression');
    expect(worse.status).toBe(1);
    expect(worse.stdout).toContain('Explicit any in application code 2 → 3');
    expect(run(root, '--offline', '--project', 'shop', '--fail-on', 'regression').status).toBe(0);

    const refused = run('baseline', root);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('admin:type-safety.explicit-any: 2 -> 3');

    writeFileSync(join(root, 'apps/admin/src/app.module.ts'), adminModule(1));
    expect(run('baseline', root).stdout).toContain('lowered admin:type-safety.explicit-any: 2 -> 1');
  });

  it('says how to record the projects when the baseline predates them', () => {
    root = nxWorkspace();
    expect(run('baseline', root).status).toBe(0);
    const old = JSON.parse(readFileSync(baselinePath(), 'utf8')) as Baseline;
    delete old.projects;
    writeFileSync(baselinePath(), serializeBaseline(old));
    const missing = run(root, '--offline', '--project', 'admin', '--fail-on', 'regression');
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("needs that project's numbers in the baseline");
    // Without --fail-on the run simply does not compare, instead of reading the workspace's numbers as admin's.
    const plain = run(root, '--offline', '--project', 'admin');
    expect(plain.status).toBe(0);
    expect(plain.stdout).not.toContain('Baseline');
  });
});
