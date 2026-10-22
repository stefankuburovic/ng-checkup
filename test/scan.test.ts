import { join } from 'node:path';
import { scanAngularJsTemplate } from '../src/angularjs.js';
import { scanSourceFile, scanTemplate, scanTemplateFile } from '../src/scan.js';
import { removeTemp, writeTemp } from './helpers.js';

describe('scanSourceFile', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  const scan = (code: string, name = 'src/file.ts') => {
    root = writeTemp({ [name]: code });
    return scanSourceFile(root, join(root, name));
  };

  it('keys calls by the module they were imported from, not by their name', () => {
    const facts = scan(`
      import { signal, input } from '@angular/core';
      import * as core from '@angular/core';
      function computed() { return 1; }
      const a = signal(1);
      const b = input.required<string>();
      const c = core.effect(() => {});
      const d = computed();
    `);
    expect(facts.calls.get('@angular/core#signal')).toEqual([5]);
    expect(facts.calls.get('@angular/core#input.required')).toEqual([6]);
    expect(facts.calls.get('@angular/core#effect')).toEqual([7]);
    // A local helper named like an Angular API is not one.
    expect(facts.calls.has('@angular/core#computed')).toBe(false);
  });

  it('marks type-only imports and records dynamic imports separately', () => {
    const facts = scan(`
      import type { A } from './a';
      import { type B, type C } from './b';
      import { D, type E } from './d';
      export { F } from './f';
      const lazy = () => import('./lazy');
    `);
    const bySpecifier = Object.fromEntries(facts.imports.map((fact) => [fact.specifier, fact]));
    expect(bySpecifier['./a']?.typeOnly).toBe(true);
    expect(bySpecifier['./b']?.typeOnly).toBe(true);
    expect(bySpecifier['./d']?.typeOnly).toBe(false);
    expect(bySpecifier['./f']?.typeOnly).toBe(false);
    expect(bySpecifier['./lazy']?.dynamic).toBe(true);
  });

  it('reads component metadata as written, leaving defaults to the checks', () => {
    const facts = scan(`
      import { ChangeDetectionStrategy, Component, Input, Output, NgModule } from '@angular/core';
      @Component({ selector: 'a', standalone: false, changeDetection: ChangeDetectionStrategy.OnPush, template: '<p *ngIf="x">{{ x }}</p>' })
      export class A {
        @Input() x = 1;
        @Input() set y(value: number) {}
        @Output() changed = 1;
      }
      @Component({ selector: 'b', template: '' })
      export class B {}
      @NgModule({})
      export class M {}
    `);
    expect(facts.components).toStrictEqual([
      { name: 'A', line: 3, standalone: false, changeDetection: 'OnPush' },
      // Nothing written, so nothing recorded: what absent means depends on the Angular version.
      { name: 'B', line: 9 },
    ]);
    expect(facts.decoratorInputs).toBe(2);
    expect(facts.decoratorOutputs).toBe(1);
    expect(facts.ngModules).toBe(1);
    expect(facts.inlineTemplates).toHaveLength(2);
    expect(facts.inlineTemplates[0]?.stats.ngIf).toBe(1);
    expect(facts.inlineTemplates[0]?.firstLegacyLine).toBe(3);
  });

  it('ignores a decorator named Component that does not come from Angular', () => {
    const facts = scan(`
      import { Component } from './my-decorators';
      @Component({})
      export class NotAngular {}
    `);
    expect(facts.components).toEqual([]);
  });

  it('counts the escape hatches: any, non-null assertions, definite assignment, ts comments', () => {
    const facts = scan(`
      let a: any;
      const b = (a as any)!.value;
      class C { x!: string; }
      // @ts-ignore
      // @ts-expect-error
      const d = 1;
    `);
    expect(facts.anyLines).toEqual([2, 3]);
    expect(facts.nonNullLines).toEqual([3]);
    expect(facts.definiteAssignments).toBe(1);
    expect(facts.typeSuppressions).toBe(2);
  });

  it('counts Jasmine globals, but not an imported spyOn', () => {
    const jasmineSpec = scan(`spyOn(console, 'log'); jasmine.createSpy('x'); jasmine.clock();`, 'src/a.spec.ts');
    expect(jasmineSpec.jasmineCalls).toBe(3);
    expect(jasmineSpec.isSpec).toBe(true);
    removeTemp(root);
    const vitestSpec = scan(`import { spyOn } from './helpers'; spyOn(console, 'log');`, 'src/b.spec.ts');
    expect(vitestSpec.jasmineCalls).toBe(0);
  });

  it('records constructions and member accesses of imported names', () => {
    const facts = scan(`
      import { BehaviorSubject } from 'rxjs';
      import { ChangeDetectionStrategy } from '@angular/core';
      const s = new BehaviorSubject(1);
      const d = ChangeDetectionStrategy.Default;
    `);
    expect(facts.constructions.get('rxjs#BehaviorSubject')).toEqual([4]);
    expect(facts.memberAccesses.get('@angular/core#ChangeDetectionStrategy.Default')).toEqual([5]);
  });
});

describe('scanTemplate', () => {
  it('counts legacy and built-in control flow, @defer and $any', () => {
    expect(
      scanTemplate(`
        <div *ngIf="a"></div><ng-template [ngIf]="b"></ng-template>
        <li *ngFor="let x of xs"></li>
        <div [ngSwitch]="mode"></div>
        @if (a) {} @else if (b) {} @for (x of xs; track x) {} @switch (m) {}
        @defer (on viewport) {}
        {{ $any(x).y }}
      `),
      // `@else if` is a branch of the same block, like an `else` template is part of one `*ngIf`.
    ).toEqual({ ngIf: 2, ngFor: 1, ngSwitch: 1, ifBlocks: 1, forBlocks: 1, switchBlocks: 1, deferBlocks: 1, anyCasts: 1, innerHtmlBindings: 0 });
  });

  it('reports the line of the first legacy directive of a template file', () => {
    const root = writeTemp({ 'a.html': '<p>one</p>\n<p>two</p>\n<p *ngFor="let x of y"></p>\n' });
    try {
      expect(scanTemplateFile(root, join(root, 'a.html')).firstLegacyLine).toBe(3);
    } finally {
      removeTemp(root);
    }
  });

  it('ignores markup inside HTML comments, and keeps the line numbers after them', () => {
    const template = [
      '<!-- <span *ngIf="adUri">Kennen Sie schon?</span> -->',
      '<!--',
      '  <li *ngFor="let x of xs" [innerHTML]="x"></li>',
      '  <div ng-repeat="y in ys" ng-controller="Old"></div>',
      '-->',
      '@if (a) {}',
      '<p *ngIf="b"></p>',
      '<!-- unterminated <p *ngIf="c"></p>',
    ].join('\n');
    expect(scanTemplate(template)).toMatchObject({ ngIf: 1, ngFor: 0, ifBlocks: 1, innerHtmlBindings: 0 });
    expect(scanAngularJsTemplate(template)).toMatchObject({ attributes: 0, controllers: 0 });
    const root = writeTemp({ 'a.html': template });
    try {
      expect(scanTemplateFile(root, join(root, 'a.html')).firstLegacyLine).toBe(7);
    } finally {
      removeTemp(root);
    }
  });
});

describe('isTestCode', () => {
  it('recognises specs, e2e files, page objects, mocks and test folders, by the report path', async () => {
    const { isTestCode } = await import('../src/files.js');
    for (const path of ['src/a.spec.ts', 'e2e/src/app.e2e-spec.ts', 'e2e/src/app.po.ts', 'cypress/e2e/a.cy.ts', 'test-config/mocks-ionic.ts', 'src/__mocks__/x.ts', 'src/api.mock.ts']) {
      expect(isTestCode(path), path).toBe(true);
    }
    for (const path of ['src/app/app.component.ts', 'src/app/e2e-settings.ts', 'src/app/mocking/real.service.ts']) expect(isTestCode(path), path).toBe(false);
  });
});

describe('isGeneratedFile', () => {
  it('recognises a generator header, but only before the first line of code', async () => {
    const { isGeneratedFile } = await import('../src/scan.js');
    expect(isGeneratedFile('src/api.ts', '/* eslint-disable */\n// This file was automatically generated. DO NOT EDIT.\nexport type A = 1;')).toBe(true);
    expect(isGeneratedFile('src/api.ts', '/**\n * @generated by graphql-codegen\n */\nexport type A = 1;')).toBe(true);
    expect(isGeneratedFile('src/reset.ts', "import { x } from './x';\n// token generated by the API for resetting the password\nexport const a = x;")).toBe(false);
  });

  it('recognises generated names and folders, and not a file merely about generated things', async () => {
    const { isGeneratedFile } = await import('../src/scan.js');
    for (const path of ['src/app/common/generated-types.ts', 'src/graphql.generated.ts', 'src/api.gen.ts', 'src/generated/models.ts', 'src/__generated__/schema.ts']) expect(isGeneratedFile(path, ''), path).toBe(true);
    for (const path of ['libs/isr/modify-generated-html.ts', 'src/generator.service.ts', 'src/regenerate.ts']) expect(isGeneratedFile(path, ''), path).toBe(false);
  });
});
