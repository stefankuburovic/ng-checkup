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
