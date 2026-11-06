import { runCheckup } from '../src/index.js';
import { templateSpeedOf } from '../src/template-speed.js';
import { removeTemp, writeTemp } from './helpers.js';

const names = (template: string): string[] => templateSpeedOf(template).calls.map((call) => call.name);

describe('templateSpeedOf', () => {
  it('finds *ngFor and [ngForOf] without trackBy, and leaves out literal arrays', () => {
    const facts = templateSpeedOf(
      [
        '<li *ngFor="let a of items"></li>',
        '<li *ngFor="let a of items; trackBy: byId"></li>',
        '<li *ngFor="let a of [1, 2, 3]"></li>',
        '<li *ngFor="let a of items$ | async; let i = index"></li>',
        '<ng-template ngFor let-a [ngForOf]="rows"></ng-template>',
        '<ng-template ngFor let-a [ngForOf]="rows" [ngForTrackBy]="byId"></ng-template>',
        '<!-- <li *ngFor="let a of hidden"></li> -->',
      ].join('\n'),
    );
    expect(facts.untrackedLoops).toEqual([
      { line: 1, collection: 'items' },
      { line: 4, collection: 'items$ | async' },
      { line: 5, collection: 'rows' },
    ]);
  });

  it('finds @for tracked by $index, renamed or not, and leaves out literal arrays', () => {
    const facts = templateSpeedOf(
      [
        '@for (a of items; track $index) {}',
        '@for (a of items; track a.id) {}',
        '@for (a of items; let i = $index; track i) {}',
        '@for (a of items; let i = $index; track a.id) {}',
        '@for (a of [1, 2]; track $index) {}',
        '@for (a of rows(); track $index; let last = $last) {}',
      ].join('\n'),
    );
    expect(facts.indexTrackedLoops).toEqual([
      { line: 1, collection: 'items' },
      { line: 3, collection: 'items' },
      { line: 6, collection: 'rows()' },
    ]);
  });

  it('reads calls from bindings, not from events, strings, track or chains', () => {
    expect(names('{{ total() }}')).toEqual(['total']);
    expect(names('<a [title]="label(1)" title2="{{ other() }}"></a>').sort()).toEqual(['label', 'other']);
    expect(names('<a *ngIf="visible(); else no"></a>')).toEqual(['visible']);
    expect(names('@if (ready(a) && !busy()) {}\n@else if (late()) {}').sort()).toEqual(['busy', 'late', 'ready']);
    expect(names('@for (a of rows(); track identify($index, a)) {}')).toEqual(['rows']);
    expect(names('@let x = sum(1);')).toEqual(['sum']);
    expect(names('<a *ngFor="let a of rows(); trackBy: f"></a>')).toEqual(['rows']);
    expect(names('{{ this.total() }}')).toEqual(['total']);
    expect(names('<a (click)="save()"></a>')).toEqual([]);
    expect(names('<a [(ngModel)]="value"></a>')).toEqual([]);
    expect(names(`{{ 'save()' }}`)).toEqual([]);
    expect(names('{{ form.get("a") }} {{ a?.b() }} {{ $any(x) }}')).toEqual([]);
    expect(names('@defer (on timer(500ms)) {}')).toEqual([]);
  });

  it('does not count a template variable as a call on the class', () => {
    expect(names('@for (item of rows; track item) { {{ item() }} }')).toEqual([]);
    expect(names('<a *ngFor="let row of rows">{{ row() }}</a>')).toEqual([]);
    expect(names('<ng-template let-cell>{{ cell() }}</ng-template>')).toEqual([]);
    expect(names('@let x = 1;{{ x() }}')).toEqual([]);
  });

  it('gives the line of the call, not of the tag', () => {
    expect(templateSpeedOf('<a\n  [x]="one()"\n>{{\n two() }}</a>').calls).toEqual(expect.arrayContaining([{ name: 'one', line: 2 }, { name: 'two', line: 4 }]));
  });
});

describe('template speed in the components area', () => {
  let root: string;
  afterEach(() => removeTemp(root));

  const measures = async (files: Record<string, string>): Promise<Record<string, number>> => {
    root = writeTemp({ 'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^20.0.0' } }), ...files });
    const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'components')!;
    const of = (id: string): number => check.measures!.find((measure) => measure.id === id)!.value;
    return { loops: of('untracked-ngfor'), index: of('track-by-index'), calls: of('template-method-calls'), pipes: of('impure-pipes') };
  };

  it('counts methods of the class, never signals, for inline and external templates', async () => {
    const result = await measures({
      'src/a.component.ts': `import { Component, signal, computed, input } from '@angular/core';
@Component({ selector: 'app-a', templateUrl: './a.component.html' })
export class AComponent {
  count = signal(0);
  double = computed(() => this.count() * 2);
  name = input('');
  total() { return 1; }
  arrow = () => 2;
}
@Component({ selector: 'app-b', template: '{{ late() }} {{ count() }}' })
export class BComponent {
  count = signal(0);
  late() { return 3; }
}
`,
      'src/a.component.html': '{{ count() }} {{ double() }} {{ name() }} {{ total() }} {{ arrow() }} {{ inherited() }} <a (click)="total()"></a>',
    });
    expect(result.calls).toBe(3);
  });

  it('reads nothing from a template no class owns', async () => {
    const result = await measures({
      'src/a.component.ts': "import { Component } from '@angular/core';\n@Component({ selector: 'app-a', template: '' })\nexport class AComponent { total() {} }\n",
      'src/orphan.html': '<li *ngFor="let a of rows">{{ total() }}</li> @for (a of rows; track $index) {}',
    });
    expect(result).toEqual({ loops: 0, index: 0, calls: 0, pipes: 0 });
  });

  it('needs every class that shares a template to declare the method', async () => {
    const result = await measures({
      'src/a.component.ts': "import { Component } from '@angular/core';\n@Component({ selector: 'app-a', templateUrl: './s.html' })\nexport class AComponent { one() {} two() {} }\n@Component({ selector: 'app-b', templateUrl: './s.html' })\nexport class BComponent { one() {} two = 1; }\n",
      'src/s.html': '{{ one() }} {{ two() }}',
    });
    expect(result.calls).toBe(1);
  });

  it('leaves out constant collections, and keeps one the class changes or a parent binds', async () => {
    const result = await measures({
      'src/a.component.ts': `import { Component, Input } from '@angular/core';
const STEPS = ['a'];
@Component({ selector: 'app-a', templateUrl: './a.html' })
export class AComponent {
  fixed = ['a', 'b'];
  readonly steps = STEPS;
  pushed = ['a'];
  empty = [];
  @Input() bound = ['a'];
  add() { this.pushed.push('b'); }
}
`,
      'src/a.html': '@for (a of fixed; track $index) {}\n@for (a of steps; track $index) {}\n@for (a of pushed; track $index) {}\n@for (a of empty; track $index) {}\n<li *ngFor="let a of bound"></li>\n<li *ngFor="let a of fixed"></li>',
    });
    expect(result.index).toBe(2);
    expect(result.loops).toBe(1);
  });

  it('counts impure pipes a template uses, and only those', async () => {
    const result = await measures({
      'src/p.ts': "import { Pipe } from '@angular/core';\n@Pipe({ name: 'live', pure: false })\nexport class LivePipe {}\n@Pipe({ name: 'idle', pure: false })\nexport class IdlePipe {}\n@Pipe({ name: 'plain' })\nexport class PlainPipe {}\n",
      'src/a.component.ts': "import { Component } from '@angular/core';\n@Component({ selector: 'app-a', template: '{{ 1 | live }} {{ 1 | plain }}' })\nexport class AComponent {}\n",
    });
    expect(result.pipes).toBe(1);
  });

  it('never changes the grade, and reports inline lines on the component file', async () => {
    root = writeTemp({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^20.0.0' } }),
      'src/a.component.ts': "import { Component } from '@angular/core';\n@Component({\n  selector: 'app-a',\n  template: `\n    {{ total() }}\n  `,\n})\nexport class AComponent { total() {} }\n",
    });
    const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'components')!;
    const finding = check.findings.find((entry) => entry.message.includes('method call'))!;
    expect(finding.severity).toBe('low');
    expect(finding.files).toEqual([{ path: 'src/a.component.ts', line: 5 }]);
    expect(check.grade).toBe('good');
  });
});
