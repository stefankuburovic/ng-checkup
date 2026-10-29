import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of a fixture project under `test/fixtures`. */
export function fixture(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name);
}

/**
 * Writes `files` (relative path to content) into a fresh temporary directory
 * and returns its path. For tests that need one or two source files rather
 * than a whole fixture project. Pair with `removeTemp` in `afterEach`.
 */
export function writeTemp(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ng-checkup-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

/** Deletes a directory made by `writeTemp`. */
export function removeTemp(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** An Nx workspace: a clean standalone app, a legacy NgModule app, a library, and a root script owned by nobody. */
export function nxWorkspace(): string {
  const project = (name: string, type: string, root: string) =>
    JSON.stringify({ name, projectType: type, targets: { build: { executor: '@angular/build:application', options: { tsConfig: `${root}/tsconfig.app.json` } } } });
  return writeTemp({
    'nx.json': '{}',
    'package.json': JSON.stringify({ name: 'monorepo', dependencies: { '@angular/core': '~20.0.0' } }),
    'apps/shop/project.json': project('shop', 'application', 'apps/shop'),
    'apps/shop/tsconfig.app.json': JSON.stringify({ compilerOptions: { strict: true }, angularCompilerOptions: { strictTemplates: true } }),
    'apps/shop/src/app.component.ts':
      "import { ChangeDetectionStrategy, Component } from '@angular/core';\n@Component({ selector: 'shop', template: '', changeDetection: ChangeDetectionStrategy.OnPush })\nexport class ShopComponent {}\n",
    'apps/admin/project.json': project('admin', 'application', 'apps/admin'),
    'apps/admin/tsconfig.app.json': JSON.stringify({ compilerOptions: { strict: false } }),
    'apps/admin/src/app.module.ts':
      "import { Component, NgModule } from '@angular/core';\n@Component({ selector: 'admin', template: '<p *ngIf=\"x\"></p>' })\nexport class AdminComponent { x: any; y: any; }\n@NgModule({ declarations: [AdminComponent] })\nexport class AppModule {}\n",
    'libs/ui/project.json': JSON.stringify({ name: 'ui', projectType: 'library' }),
    'libs/ui/src/button.ts': "import { Directive } from '@angular/core';\n@Directive({ selector: '[uiButton]' })\nexport class ButtonDirective {}\n",
    'tools/script.ts': 'export const script = 1;\n',
    'apps/shop-e2e/project.json': JSON.stringify({ name: 'shop-e2e', projectType: 'application' }),
    'apps/shop-e2e/src/app.cy.ts': "describe('shop', () => it('loads', () => cy.visit('/')));\n",
  });
}
