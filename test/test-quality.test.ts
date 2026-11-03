import ts from 'typescript';
import { runCheckup } from '../src/index.js';
import { testQualityOf } from '../src/test-quality.js';
import { removeTemp, writeTemp } from './helpers.js';

/** Test-quality facts of a spec written as `lines`. */
function quality(lines: string[]) {
  return testQualityOf(ts.createSourceFile('a.spec.ts', lines.join('\n'), ts.ScriptTarget.Latest, true));
}

describe('test quality', () => {
  it('finds tests that assert nothing, and counts helpers, namespaces and Cypress as asserting', () => {
    const facts = quality([
      "it('renders', () => { fixture.detectChanges(); });",
      "it('is empty', () => {});",
      "it('expects', () => { expect(1).toBe(1); });",
      "it('uses a helper', () => { expectRow(0); });",
      "it('uses a local helper', () => { rowIsShown(); });",
      "it('uses a namespace', async () => { await expect.element(input).toHaveValue(42); });",
      "it('drives Cypress', () => { cy.visit('/'); });",
      "xit('is skipped', () => {});",
      "it.skip('is skipped too', () => {});",
      "it.todo('later');",
      "test.only('is focused and empty', () => {});",
      "it('is a type test', () => {\n  // @ts-expect-error a number is no string\n  const x: string = 1;\n});",
      'function rowIsShown() { expect(row).toBeTruthy(); }',
    ]);
    expect(facts.withoutAssertions).toEqual([1, 2, 11]);
  });

  it('finds an assertion in a subscribe the test does not wait for, and leaves every waiting shape alone', () => {
    const facts = quality([
      "it('lost', () => { timer(10).subscribe((x) => expect(x).toBe(0)); });",
      "it('done', (done) => { timer(10).subscribe((x) => { expect(x).toBe(0); done(); }); });",
      "it('fake', fakeAsync(() => { timer(10).subscribe((x) => expect(x).toBe(0)); tick(10); }));",
      "it('flushed', () => { service.load().subscribe((x) => expect(x).toBe(0)); http.expectOne('/x').flush(0); });",
      "it('awaited', async () => { source$.subscribe((x) => expect(x).toBe(0)); await fixture.whenStable(); });",
      "it('no assertion inside', () => { source$.subscribe((x) => seen.push(x)); expect(seen).toEqual([]); });",
      "it('returns a promise', () => new Promise<void>((done) => { source$.subscribe((x) => { expect(x).toBe(0); done(); }); }));",
      "it('marble', () => { testScheduler.run(() => { state$.subscribe((x) => expect(x).toBe(1)); }); });",
      "it('returns in a block', () => { return new Promise<void>((resolve) => source$.subscribe((x) => { expect(x).toBe(0); resolve(); })); });",
    ]);
    expect(facts.unawaitedSubscribeAssertions).toEqual([1]);
  });

  it('finds the schemas that silence template errors, not their import', () => {
    const facts = quality(["import { NO_ERRORS_SCHEMA } from '@angular/core';", 'TestBed.configureTestingModule({', '  schemas: [NO_ERRORS_SCHEMA, CUSTOM_ELEMENTS_SCHEMA],', '});']);
    expect(facts.schemaSuppressions).toEqual([3]);
  });

  it('reports them as findings and measures of the testing area without moving its grade', async () => {
    const root = writeTemp({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^20.0.0' }, devDependencies: { vitest: '^3.0.0' } }),
      'src/app/a.service.ts': "import { Injectable } from '@angular/core';\n@Injectable()\nexport class A {}\n",
      'src/app/a.service.spec.ts': ["it('creates', () => { new A(); });", "it('emits', () => { timer(1).subscribe((x) => expect(x).toBe(0)); });", 'TestBed.configureTestingModule({ schemas: [NO_ERRORS_SCHEMA] });'].join('\n'),
    });
    try {
      const testing = (await runCheckup(root, { offline: true })).checks.find((check) => check.id === 'testing')!;
      const measure = (id: string) => testing.measures?.find((entry) => entry.id === id)?.value;
      expect([measure('tests-without-assertions'), measure('unawaited-subscribe-assertions'), measure('schema-suppressed-specs')]).toEqual([1, 1, 1]);
      expect(testing.findings.map((finding) => finding.message)).toEqual([
        'No end-to-end test setup found',
        '1 test asserts nothing',
        '1 assertion inside a `.subscribe()` the test does not wait for',
        '1 spec file silences template errors with `NO_ERRORS_SCHEMA` or `CUSTOM_ELEMENTS_SCHEMA`',
      ]);
      expect(testing.grade).toBe('good');
    } finally {
      removeTemp(root);
    }
  });
});
