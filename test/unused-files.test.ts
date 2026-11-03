import { runCheckup } from '../src/index.js';
import type { Report } from '../src/types.js';
import { removeTemp, writeTemp } from './helpers.js';

/** The architecture check's unused-files measure and the files its finding lists. */
function unused(report: Report): { value: number | undefined; files: string[] } {
  const architecture = report.checks.find((check) => check.id === 'architecture');
  const finding = architecture?.findings.find((entry) => entry.message.endsWith('nothing imports'));
  return { value: architecture?.measures?.find((measure) => measure.id === 'unused-files')?.value, files: finding?.files?.map((file) => file.path) ?? [] };
}

/** The components, directives and pipes the architecture check reports as unused, with the files listed as `path:line`. */
function unusedDeclarables(report: Report, suffix = 'no template uses'): { components: number | undefined; attributeSelectors: number | undefined; pipes: number | undefined; files: string[] } {
  const architecture = report.checks.find((check) => check.id === 'architecture');
  const finding = architecture?.findings.find((entry) => entry.message.endsWith(suffix));
  const measure = (id: string): number | undefined => architecture?.measures?.find((entry) => entry.id === id)?.value;
  return { components: measure('unused-components'), attributeSelectors: measure('unused-attribute-selectors'), pipes: measure('unused-pipes'), files: finding?.files?.map((file) => `${file.path}:${file.line}`) ?? [] };
}

/** An Angular CLI app at the root with `src/main.ts` as its entry, plus `files`. */
function cliApp(files: Record<string, string>): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^20.0.0' } }),
    'angular.json': JSON.stringify({
      projects: {
        web: {
          root: '',
          sourceRoot: 'src',
          projectType: 'application',
          architect: {
            build: {
              builder: '@angular/build:application',
              options: { browser: 'src/main.ts', tsConfig: 'tsconfig.app.json' },
              configurations: { production: { fileReplacements: [{ replace: 'src/env/env.ts', with: 'src/env/env.prod-eu.ts' }] } },
            },
          },
        },
      },
    }),
    'tsconfig.app.json': JSON.stringify({ compilerOptions: { strict: true } }),
    'src/main.ts': "import { bootstrapApplication } from '@angular/platform-browser';\nimport { AppComponent } from './app/app.component';\nbootstrapApplication(AppComponent);\n",
    ...files,
  };
}

describe('files nothing imports', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) removeTemp(root);
    root = undefined;
  });

  it('lists only the file no import, route, worker, spec or build option reaches', async () => {
    root = writeTemp(
      cliApp({
        'src/app/app.component.ts': [
          "import { Component } from '@angular/core';",
          "import type { Hero } from './hero';",
          "export const routes = [{ path: 'admin', loadComponent: () => import('./admin.component').then((m) => m.AdminComponent) }];",
          "const worker = new Worker(new URL('./crunch.worker', import.meta.url));",
          "@Component({ selector: 'app-root', template: '' })",
          'export class AppComponent { hero?: Hero; worker = worker; }',
          '',
        ].join('\n'),
        'src/app/hero.ts': 'export interface Hero { name: string }\n',
        'src/app/admin.component.ts': "import { Component } from '@angular/core';\n@Component({ selector: 'app-admin', template: '' })\nexport class AdminComponent {}\n",
        'src/app/crunch.worker.ts': 'addEventListener("message", () => postMessage(1));\n',
        'src/app/tested-only.ts': 'export const value = 1;\n',
        'src/app/tested-only.spec.ts': "import { value } from './tested-only';\nit('works', () => expect(value).toBe(1));\n",
        'src/app/old.service.ts': 'export class OldService {}\n',
        'src/env/env.ts': 'export const env = {};\n',
        'src/env/env.prod-eu.ts': 'export const env = { prod: true };\n',
        'server.ts': 'console.log("a script next to angular.json, outside the source root");\n',
      }),
    );
    expect(unused(await runCheckup(root, { offline: true }))).toEqual({ value: 1, files: ['src/app/old.service.ts'] });
  });

  it('follows an Angular 7 string loadChildren resolved against the source root', async () => {
    root = writeTemp(
      cliApp({
        'src/app/app.component.ts': "import { Component } from '@angular/core';\nexport const routes = [{ path: 'admin', loadChildren: 'app/admin/admin.module#AdminModule' }];\n@Component({ selector: 'app-root', template: '' })\nexport class AppComponent {}\n",
        'src/app/admin/admin.module.ts': "import { NgModule } from '@angular/core';\n@NgModule({})\nexport class AdminModule {}\n",
      }),
    );
    expect(unused(await runCheckup(root, { offline: true }))).toEqual({ value: 0, files: [] });
  });

  it('counts a library entry from paths or package.json exports as used, and skips projects without Angular', async () => {
    root = writeTemp({
      'nx.json': '{}',
      'package.json': JSON.stringify({ name: 'mono', dependencies: { '@angular/core': '^20.0.0' } }),
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@mono/ui': ['libs/ui/src/index.ts'] } } }),
      'libs/ui/project.json': JSON.stringify({ name: 'ui', projectType: 'library', sourceRoot: 'libs/ui/src' }),
      'libs/ui/src/index.ts': "export * from './button.component';\n",
      'libs/ui/src/button.component.ts': "import { Component } from '@angular/core';\n@Component({ selector: 'ui-button', template: '' })\nexport class ButtonComponent {}\n",
      'libs/state/project.json': JSON.stringify({ name: 'state', projectType: 'library', sourceRoot: 'libs/state/src' }),
      'libs/state/package.json': JSON.stringify({ name: '@mono/state', exports: { '.': { default: './src/index.ts' }, './testing': { default: './src/testing.ts' } } }),
      'libs/state/src/index.ts': "import { signal } from '@angular/core';\nexport const count = signal(0);\n",
      'libs/state/src/testing.ts': 'export const fake = 1;\n',
      'apps/react/project.json': JSON.stringify({ name: 'react', projectType: 'application', sourceRoot: 'apps/react/src' }),
      'apps/react/src/orphan.ts': "import React from 'react';\nexport const x = React;\n",
    });
    expect(unused(await runCheckup(root, { offline: true }))).toEqual({ value: 0, files: [] });
  });

  it('leaves the measure out for a repository without projects', async () => {
    root = writeTemp({ 'package.json': JSON.stringify({ name: 'loose', dependencies: { '@angular/core': '^20.0.0' } }), 'src/orphan.ts': "import { signal } from '@angular/core';\nexport const x = signal(1);\n" });
    expect(unused(await runCheckup(root, { offline: true }))).toEqual({ value: undefined, files: [] });
  });
});

describe('components and pipes no template uses', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) removeTemp(root);
    root = undefined;
  });

  /** A component class with `selector` and an inline `template`, in its own file. */
  const component = (name: string, selector: string, template = ''): string =>
    `import { Component } from '@angular/core';\n@Component({ selector: '${selector}', template: \`${template}\` })\nexport class ${name} {}\n`;
  /** A pipe class called `name` in templates. */
  const pipe = (className: string, name: string): string =>
    `import { Pipe, PipeTransform } from '@angular/core';\n@Pipe({ name: '${name}' })\nexport class ${className} implements PipeTransform { transform(value: string): string { return value; } }\n`;

  it('reports what only an NgModule lists, and keeps what a template, route, dialog or inject() uses', async () => {
    root = writeTemp(
      cliApp({
        'src/index.html': '<body><app-root></app-root></body>\n',
        'src/app/app.component.ts': component('AppComponent', 'app-root', '<app-hero></app-hero> <span appTooltip>{{ name | shout }} {{ a || b }}</span> <!-- <app-old></app-old> {{ x | whisper }} -->'),
        'src/app/hero.component.ts': component('HeroComponent', 'app-hero'),
        'src/app/old.component.ts': component('OldComponent', 'app-old'),
        'src/app/routed.component.ts': component('RoutedComponent', 'app-routed'),
        'src/app/dialog.component.ts': component('DialogComponent', 'app-dialog'),
        'src/app/tooltip.component.ts': component('TooltipComponent', '[appTooltip]'),
        'src/app/shout.pipe.ts': pipe('ShoutPipe', 'shout'),
        'src/app/whisper.pipe.ts': pipe('WhisperPipe', 'whisper'),
        'src/app/format.pipe.ts': pipe('FormatPipe', 'format'),
        'src/app/opener.service.ts': [
          "import { inject, Injectable } from '@angular/core';",
          "import { DialogComponent } from './dialog.component';",
          "import { FormatPipe } from './format.pipe';",
          '@Injectable()',
          'export class OpenerService { format = inject(FormatPipe); open(dialog: { open(c: unknown): void }) { dialog.open(DialogComponent); } }',
          '',
        ].join('\n'),
        'src/app/app.module.ts': [
          "import { NgModule } from '@angular/core';",
          "import { RouterModule } from '@angular/router';",
          "import { AppComponent } from './app.component';",
          "import { HeroComponent } from './hero.component';",
          "import { OldComponent } from './old.component';",
          "import { RoutedComponent } from './routed.component';",
          "import { TooltipComponent } from './tooltip.component';",
          "import { ShoutPipe } from './shout.pipe';",
          "import { WhisperPipe } from './whisper.pipe';",
          "import { OpenerService } from './opener.service';",
          '@NgModule({',
          "  imports: [RouterModule.forRoot([{ path: 'r', component: RoutedComponent }])],",
          '  declarations: [AppComponent, HeroComponent, OldComponent, TooltipComponent, ShoutPipe, WhisperPipe],',
          '  exports: [HeroComponent],',
          '  providers: [OpenerService],',
          '  bootstrap: [AppComponent],',
          '})',
          'export class AppModule {}',
          '',
        ].join('\n'),
        'src/main.ts': "import { platformBrowser } from '@angular/platform-browser';\nimport { AppModule } from './app/app.module';\nplatformBrowser().bootstrapModule(AppModule);\n",
      }),
    );
    expect(unusedDeclarables(await runCheckup(root, { offline: true }))).toEqual({ components: 1, attributeSelectors: undefined, pipes: 1, files: ['src/app/old.component.ts:2', 'src/app/whisper.pipe.ts:2'] });
  });

  it('with --attribute-selectors, matches directive selectors by attribute, binding, structural star, output and tag, and skips what a template cannot settle', async () => {
    /** A directive class with `selector`. */
    const directive = (name: string, selector: string, extra = ''): string =>
      `import { Directive } from '@angular/core';\n@Directive({ selector: '${selector}'${extra} })\nexport class ${name} {}\n`;
    root = writeTemp(
      cliApp({
        'src/index.html': '<app-root></app-root>\n',
        'src/app/app.component.ts': [
          "import { Component } from '@angular/core';",
          "import { FocusDirective } from './focus.directive';",
          '@Component({',
          "  selector: 'app-root',",
          '  hostDirectives: [FocusDirective],',
          '  template: `<div [appHighlight]="color"></div> <p *appUnless="x > 1"></p> <button appPress>Go</button> <input [(appModel)]="v" (appGone)="no()" #appRef>`,',
          '})',
          'export class AppComponent {}',
          '',
        ].join('\n'),
        'src/app/highlight.directive.ts': directive('HighlightDirective', '[appHighlight]'),
        'src/app/unless.directive.ts': directive('UnlessDirective', '[appUnless]'),
        'src/app/press.directive.ts': directive('PressDirective', 'button[appPress]'),
        'src/app/model.directive.ts': directive('ModelDirective', '[appModel]'),
        'src/app/focus.directive.ts': directive('FocusDirective', '[appFocus]'),
        'src/app/gone.directive.ts': directive('GoneDirective', '[appGone]'),
        'src/app/ref.directive.ts': directive('RefDirective', 'a[appRef], area[appRef]'),
        'src/app/card.directive.ts': directive('CardDirective', '.card'),
        'src/app/form.directive.ts': directive('FormDirective', 'form:not([ngNoForm])'),
        'src/app/base.directive.ts': "import { Directive } from '@angular/core';\n@Directive()\nexport abstract class BaseDirective {}\n",
        'src/app/app.module.ts': [
          "import { NgModule } from '@angular/core';",
          ...['Highlight', 'Unless', 'Press', 'Model', 'Gone', 'Ref', 'Card', 'Form', 'Base'].map((name) => `import { ${name}Directive } from './${name.toLowerCase()}.directive';`),
          "import { AppComponent } from './app.component';",
          '@NgModule({ declarations: [AppComponent, HighlightDirective, UnlessDirective, PressDirective, ModelDirective, GoneDirective, RefDirective, CardDirective, FormDirective], bootstrap: [AppComponent] })',
          'export class AppModule {}',
          "export const base: typeof BaseDirective | undefined = undefined;",
          '',
        ].join('\n'),
        'src/main.ts': "import { platformBrowser } from '@angular/platform-browser';\nimport { AppModule } from './app/app.module';\nplatformBrowser().bootstrapModule(AppModule);\n",
      }),
    );
    // An event binding `(appGone)` matches, as Angular matches outputs too; a reference `#appRef` does not.
    expect(unusedDeclarables(await runCheckup(root, { offline: true, attributeSelectors: true }), 'no template matches')).toEqual({ components: 0, attributeSelectors: 1, pipes: 0, files: ['src/app/ref.directive.ts:2'] });
    // Without the flag nothing about directives is reported, and the measure is not there for a baseline to record.
    expect(unusedDeclarables(await runCheckup(root, { offline: true }), 'no template matches')).toEqual({ components: 0, attributeSelectors: undefined, pipes: 0, files: [] });
  });

  it('leaves library projects alone, whose consumers may live elsewhere', async () => {
    root = writeTemp({
      'nx.json': '{}',
      'package.json': JSON.stringify({ name: 'mono', dependencies: { '@angular/core': '^20.0.0' } }),
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { paths: { '@mono/ui': ['libs/ui/src/index.ts'] } } }),
      'libs/ui/project.json': JSON.stringify({ name: 'ui', projectType: 'library', sourceRoot: 'libs/ui/src' }),
      'libs/ui/src/index.ts': "export * from './card.component';\n",
      'libs/ui/src/card.component.ts': component('CardComponent', 'ui-card'),
    });
    expect(unusedDeclarables(await runCheckup(root, { offline: true }))).toEqual({ components: 0, attributeSelectors: undefined, pipes: 0, files: [] });
  });
});

