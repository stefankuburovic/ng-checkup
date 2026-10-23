import { runCheckup } from '../src/index.js';
import { lintExemptLines } from '../src/scan.js';
import { removeTemp, writeTemp } from './helpers.js';

describe('lint-exempt lines', () => {
  const rule = '@typescript-eslint/no-explicit-any';

  it('reads next-line, same-line and block directives, with or without a rule list and a reason', () => {
    const text = [
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the API sends anything',
      'type A = any;',
      'type B = any; // eslint-disable-line',
      '/* eslint-disable @typescript-eslint/no-explicit-any */',
      'type C = any;',
      'type D = any;',
      '/* eslint-enable @typescript-eslint/no-explicit-any */',
      'type E = any;',
      '// eslint-disable-next-line no-console',
      'type F = any;',
    ].join('\n');
    const exempt = lintExemptLines(text, rule);
    expect([2, 3, 5, 6].every(exempt)).toBe(true);
    // After the block ends, and under a directive for another rule, the line counts.
    expect(exempt(8)).toBe(false);
    expect(exempt(10)).toBe(false);
  });

  it('runs a block that is never re-enabled to the end of the file', () => {
    const exempt = lintExemptLines('/* eslint-disable */\ntype A = any;\ntype B = any;', rule);
    expect(exempt(2) && exempt(3)).toBe(true);
  });
});

describe('review fixes', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) removeTemp(root);
    root = undefined;
  });

  it('keeps exempted any out of the count and says how many there are', async () => {
    root = writeTemp({
      'package.json': '{"name":"app","dependencies":{"@angular/core":"^22.0.0"}}',
      'src/a.ts': '// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport type A = any;\nexport type B = any;\n',
    });
    const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'type-safety');
    expect(check?.measures?.find((measure) => measure.id === 'explicit-any')?.value).toBe(1);
    expect(check?.findings.find((finding) => finding.severity === 'info')?.message).toBe('1 more `any` on lines with an eslint-disable for `no-explicit-any`');
  });

  it('counts a store as tested when a spec elsewhere imports it, and grades all logic together', async () => {
    root = writeTemp({
      'package.json': '{"name":"app","dependencies":{"@angular/core":"^22.0.0","@ngrx/signals":"^20.0.0","vitest":"^4.0.0"}}',
      'src/app/store/cart.store.ts': "import { signalStore } from '@ngrx/signals';\nexport const CartStore = signalStore();\n",
      'src/app/store/index.ts': "export * from './cart.store';\n",
      'src/app/utilities/price.utility.ts': 'export const price = (cents: number) => cents / 100;\n',
      'src/app/thing.service.ts': "import { Injectable } from '@angular/core';\n@Injectable()\nexport class ThingService {}\n",
      'src/tests/store.spec.ts': "import { CartStore } from '../app/store';\nimport { ThingService } from '../app/thing.service';\nit('works', () => [CartStore, ThingService]);\n",
    });
    const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'testing');
    // The service is covered by import, not by a neighbouring spec; the store through the barrel.
    expect(check?.metrics.find((metric) => metric.label === 'With a spec')?.value).toBe('100%');
    expect(check?.metrics.find((metric) => metric.label === 'Stores and utilities with a spec')).toEqual({ label: 'Stores and utilities with a spec', value: '50%', hint: '1 of 2 files' });
  });

  it('never grades architecture poor for file size alone', async () => {
    const long = Array.from({ length: 1100 }, (_, index) => `export const v${index} = ${index};`).join('\n');
    root = writeTemp({ 'package.json': '{"name":"app","dependencies":{"@angular/core":"^22.0.0"}}', 'src/a.ts': long, 'src/b.ts': long, 'src/c.ts': long });
    const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'architecture');
    expect(check?.grade).toBe('fair');
  });
});

describe('manual subscriptions', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) removeTemp(root);
    root = undefined;
  });

  it('counts .subscribe() in components and directives, and which are tied to the lifetime', async () => {
    root = writeTemp({
      'package.json': '{"name":"app","dependencies":{"@angular/core":"^22.0.0"}}',
      'src/list.component.ts': [
        "import { Component, DestroyRef, inject } from '@angular/core';",
        "import { takeUntilDestroyed } from '@angular/core/rxjs-interop';",
        "@Component({ selector: 'app-list', template: '' })",
        'export class ListComponent {',
        '  constructor() {',
        '    source$.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((value) => (this.value = value));',
        '    other$.subscribe(() => {});',
        '  }',
        '}',
      ].join('\n'),
      'src/data.service.ts': "import { Injectable } from '@angular/core';\n@Injectable()\nexport class DataService { load() { source$.subscribe(); } }\n",
    });
    const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'components');
    expect(check?.measures?.find((measure) => measure.id === 'manual-subscriptions')?.value).toBe(2);
    expect(check?.findings.find((finding) => finding.message.includes('.subscribe()'))?.message).toBe("2 manual `.subscribe()` calls in components and directives, 1 not tied to the component's lifetime");
  });
});
