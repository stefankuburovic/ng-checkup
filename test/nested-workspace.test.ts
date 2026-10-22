import { runCheckup } from '../src/index.js';
import { removeTemp, writeTemp } from './helpers.js';

/** An Angular workspace in `folder`, with one app whose single route is lazy. */
function angularApp(folder: string, major: number): Record<string, string> {
  return {
    [`${folder}/package.json`]: JSON.stringify({ name: `${folder.replace(/\W/g, '-')}-ui`, dependencies: { '@angular/core': `^${major}.0.0` } }),
    [`${folder}/angular.json`]: JSON.stringify({
      projects: { web: { root: '', projectType: 'application', architect: { build: { builder: '@angular/build:application', options: { browser: 'src/main.ts', tsConfig: 'tsconfig.app.json' } } } } },
    }),
    [`${folder}/tsconfig.app.json`]: JSON.stringify({ compilerOptions: { strict: true }, angularCompilerOptions: { strictTemplates: true } }),
    [`${folder}/src/main.ts`]: "import { routes } from './app/routes';\nconsole.log(routes);\n",
    [`${folder}/src/app/routes.ts`]: "export const routes = [{ path: 'admin', loadComponent: () => import('./admin.component').then((m) => m.AdminComponent) }];\n",
    [`${folder}/src/app/admin.component.ts`]: "import { Component } from '@angular/core';\n@Component({ selector: 'app-admin', template: '' })\nexport class AdminComponent {}\n",
  };
}

describe('an Angular workspace in a subfolder', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) removeTemp(root);
    root = undefined;
  });

  it('is read as the workspace when the root has none, with project roots relative to the root', async () => {
    root = writeTemp({ 'setup.py': 'print("a Python server")\n', 'server/app.py': '', ...angularApp('server/static', 21) });
    const report = await runCheckup(root, { offline: true });
    expect(report.project.workspaceFolder).toBe('server/static');
    expect(report.project.name).toBe('server-static-ui');
    expect(report.project.angularVersion).toBe('^21.0.0');
    expect(report.checks.find((check) => check.id === 'version')?.summary).toContain('Angular ^21.0.0');
    // The entry is found through the subfolder's angular.json, so the lazy route is recognised as lazy.
    expect(report.checks.find((check) => check.id === 'architecture')?.summary).toContain('100% of 1 route lazy');
    expect(report.checks.find((check) => check.id === 'type-safety')?.summary).toContain('strictTemplates on');
  });

  it('is left alone when the root is an Angular workspace itself', async () => {
    root = writeTemp({ ...angularApp('.', 22), ...angularApp('examples/demo', 17) });
    const report = await runCheckup(root, { offline: true });
    expect(report.project.workspaceFolder).toBeUndefined();
    expect(report.project.angularVersion).toBe('^22.0.0');
  });

  it('names the subfolders to run on when there are several', async () => {
    root = writeTemp({ 'README.md': '# two apps', ...angularApp('admin', 20), ...angularApp('shop', 21) });
    const report = await runCheckup(root, { offline: true });
    expect(report.project.workspaceFolder).toBeUndefined();
    expect(report.checks.find((check) => check.id === 'version')?.summary).toBe('No Angular workspace at the root; 2 subfolders have one: `admin`, `shop`. Run ng-checkup on one of them (`npx ng-checkup admin`).');
  });
});
