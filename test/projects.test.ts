import { runCheckup } from '../src/index.js';
import { owningProject, type ProjectInfo } from '../src/workspace.js';
import { nxWorkspace, removeTemp, writeTemp } from './helpers.js';

describe('per-project reports', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  it('adds one row per project, worst first, graded on the code checks only', async () => {
    root = nxWorkspace();
    const report = await runCheckup(root, { offline: true });
    const rows = report.projects!;
    expect(rows[0]).toMatchObject({ name: 'admin', type: 'application', root: 'apps/admin', sourceFiles: 1 });
    // shop-e2e imports nothing from Angular, so it has no row.
    expect(rows.map((row) => row.name).sort()).toEqual(['admin', 'shop', 'ui']);
    const admin = rows[0]!;
    expect(admin.score).toBeLessThan(rows.find((row) => row.name === 'shop')!.score!);
    expect(Object.keys(admin.grades)).not.toContain('version');
    expect(Object.keys(admin.grades)).not.toContain('dependencies');
    expect(admin.grades['type-safety']).not.toBe('good');
    expect(rows.find((row) => row.name === 'shop')!.grades['type-safety']).toBe('good');
    // The whole-workspace run still counts the file nobody owns.
    expect(report.project.sourceFiles).toBe(5);
  });

  it('narrows a run to one project with --project, and names the projects when it does not exist', async () => {
    root = nxWorkspace();
    const admin = await runCheckup(root, { offline: true, project: 'admin' });
    expect(admin.project).toMatchObject({ name: 'admin', sourceFiles: 1, templateFiles: 0 });
    expect(admin.projects).toBeUndefined();
    expect(admin.checks.find((check) => check.id === 'type-safety')!.grade).not.toBe('good');
    expect((await runCheckup(root, { offline: true, project: 'shop' })).checks.find((check) => check.id === 'type-safety')!.grade).toBe('good');
    await expect(runCheckup(root, { offline: true, project: 'nope' })).rejects.toThrow('No project named nope. Projects: admin, shop, shop-e2e, ui');
  });

  it('gives no breakdown for a single-project workspace', async () => {
    root = writeTemp({ 'angular.json': JSON.stringify({ projects: { app: { root: '', projectType: 'application' } } }), 'package.json': '{}', 'src/a.ts': 'export const a = 1;' });
    expect((await runCheckup(root, { offline: true })).projects).toBeUndefined();
  });
});

describe('owningProject', () => {
  it('picks the deepest project root, so a nested library keeps its files', () => {
    const projects: ProjectInfo[] = [
      { name: 'app', root: '', type: 'application' },
      { name: 'lib', root: 'projects/lib', type: 'library' },
    ];
    expect(owningProject('src/main.ts', projects)?.name).toBe('app');
    expect(owningProject('projects/lib/src/x.ts', projects)?.name).toBe('lib');
    expect(owningProject('projects/library/x.ts', projects)?.name).toBe('app');
    expect(owningProject('x.ts', [projects[1]!])).toBeUndefined();
  });
});
