import { join } from 'node:path';
import { findTangles, readCompilerOptions, stronglyConnectedComponents } from '../src/graph.js';
import { scanSourceFile } from '../src/scan.js';
import { removeTemp, writeTemp } from './helpers.js';

describe('stronglyConnectedComponents', () => {
  it('groups nodes that reach each other and leaves the rest alone', () => {
    const edges = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a', 'd']],
      ['d', []],
      ['e', ['e']],
    ]);
    const components = stronglyConnectedComponents(edges).map((component) => component.sort());
    expect(components).toContainEqual(['a', 'b', 'c']);
    expect(components).toContainEqual(['d']);
    expect(components).toContainEqual(['e']);
  });

  it('survives a chain far deeper than the call stack', () => {
    const edges = new Map<string, string[]>();
    for (let index = 0; index < 50_000; index++) edges.set(`n${index}`, [`n${index + 1}`]);
    edges.set('n50000', ['n0']);
    expect(stronglyConnectedComponents(edges)).toHaveLength(1);
  });
});

describe('findTangles', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  const tanglesOf = (files: Record<string, string>, tsconfig?: string) => {
    root = writeTemp(tsconfig ? { ...files, 'tsconfig.json': tsconfig } : files);
    const facts = Object.keys(files).map((path) => scanSourceFile(root, join(root, path)));
    return findTangles(facts, readCompilerOptions(tsconfig ? join(root, 'tsconfig.json') : undefined));
  };

  it('finds a loop through a barrel and gives a concrete path through it', () => {
    const tangles = tanglesOf({
      'src/a.ts': `import { b } from './b'; export const a = b;`,
      'src/b.ts': `import { c } from './lib'; export const b = c;`,
      'src/lib/index.ts': `export * from './c';`,
      'src/lib/c.ts': `import { a } from '../a'; export const c = a;`,
    });
    expect(tangles).toHaveLength(1);
    expect(tangles[0]?.files).toEqual(['src/a.ts', 'src/b.ts', 'src/lib/c.ts', 'src/lib/index.ts']);
    expect(tangles[0]?.example).toEqual(['src/a.ts', 'src/b.ts', 'src/lib/index.ts', 'src/lib/c.ts', 'src/a.ts']);
  });

  it('ignores an import of names that are only types, written without `import type`, also through a barrel', () => {
    expect(
      tanglesOf({
        'src/model.ts': `import { ID } from './ids'; import { Shape } from './shapes'; export class Model { id?: ID; shape?: Shape; }`,
        'src/ids.ts': `import { Model } from './model'; export type ID = string; export const make = () => new Model();`,
        'src/shapes/index.ts': `export * from './shape';`,
        'src/shapes/shape.ts': `import { Model } from '../model'; export interface Shape { model: Model } export const DEFAULT = new Model();`,
      }),
    ).toEqual([]);
  });

  it('drops an import of a class used only as a type, as TypeScript does', () => {
    expect(
      tanglesOf({
        'src/action.ts': `import { Provider } from './provider'; export class Action { provider?: Provider; run(p: Provider): Provider { return p; } }`,
        'src/provider.ts': `import { Action } from './action'; export class Provider { actions = [new Action()]; }`,
        'src/listener.ts': `import { Provider } from './provider'; export class Listener implements Provider { actions = []; }`,
      }),
    ).toEqual([]);
  });

  it('keeps it when Angular injects the class through a decorated constructor, or a class extends it', () => {
    const injected = tanglesOf({
      'src/a.service.ts': `import { Injectable } from '@angular/core'; import { BService } from './b.service'; @Injectable() export class AService { constructor(private b: BService) {} }`,
      'src/b.service.ts': `import { AService } from './a.service'; export const make = () => AService;`,
    });
    expect(injected).toHaveLength(1);
    removeTemp(root);
    const extended = tanglesOf({
      'src/base.ts': `import { Child } from './child'; export class Base { static create() { return new Child(); } }`,
      'src/child.ts': `import { Base } from './base'; export class Child extends Base {}`,
    });
    expect(extended).toHaveLength(1);
  });

  it('still sees the cycle when one imported name is a value, or a type is merged with a value', () => {
    const mixed = tanglesOf({
      'src/a.ts': `import { ID, make } from './b'; export const a = make(); export type A = ID;`,
      'src/b.ts': `import { a } from './a'; export type ID = string; export const make = () => a;`,
    });
    expect(mixed).toHaveLength(1);
    removeTemp(root);
    const merged = tanglesOf({
      'src/a.ts': `import { Token } from './b'; export const a = Token;`,
      'src/b.ts': `import { a } from './a'; export interface Token { x: number } export const Token = { a };`,
    });
    expect(merged).toHaveLength(1);
  });

  it('ignores type-only, dynamic and spec imports, which cannot cause an initialisation-order crash', () => {
    expect(
      tanglesOf({
        'src/a.ts': `import type { B } from './b'; export class A { b?: B; }`,
        'src/b.ts': `import { A } from './a'; export class B { a = new A(); lazy = () => import('./c'); }`,
        'src/c.ts': `import { B } from './b'; export const c = B;`,
        'src/b.spec.ts': `import { B } from './b';`,
      }),
    ).toEqual([]);
  });

  it('resolves tsconfig path aliases', () => {
    const tangles = tanglesOf(
      {
        'src/app/a.ts': `import { b } from '@app/b'; export const a = b;`,
        'src/app/b.ts': `import { a } from '@app/a'; export const b = a;`,
      },
      JSON.stringify({ compilerOptions: { paths: { '@app/*': ['./src/app/*'] } } }),
    );
    expect(tangles.map((tangle) => tangle.files)).toEqual([['src/app/a.ts', 'src/app/b.ts']]);
  });

  it('reports a file that imports itself', () => {
    expect(tanglesOf({ 'src/self.ts': `import { x } from './self'; export const y = x;` })[0]?.example).toEqual(['src/self.ts', 'src/self.ts']);
  });
});
