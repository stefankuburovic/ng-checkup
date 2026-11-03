import { accessibilityOf } from '../src/accessibility.js';
import { runCheckup } from '../src/index.js';
import { removeTemp, writeTemp } from './helpers.js';

describe('accessibility in templates', () => {
  it('finds images without alt, unless bound or hidden', () => {
    expect(accessibilityOf('<img src="a.png">\n<img src="b.png" alt="">\n<img [alt]="name">\n<img src="c.png" aria-hidden="true">\n<!-- <img src="d.png"> -->').imagesWithoutAlt).toEqual([1]);
  });

  it('finds click handlers on non-interactive elements without a key handler', () => {
    const facts = accessibilityOf('<div (click)="go()">a</div>\n<span (click)="go()" (keydown.enter)="go()">b</span>\n<button (click)="go()">c</button>\n<li\n  (click)="go()">d</li>');
    expect(facts.clickWithoutKeyboard).toEqual([1, 4]);
  });

  it('finds buttons nothing names', () => {
    const facts = accessibilityOf(
      [
        '<button class="ql-bold"></button>',
        '<button>Save</button>',
        '<button>{{ label }}</button>',
        '<button aria-label="Close"><svg></svg></button>',
        '<button><img src="x.png" alt="Delete"></button>',
        '<button><mat-icon>delete</mat-icon></button>',
        '<button><ng-content></ng-content></button>',
        '<button>\n  @if (busy) {\n    <spinner />\n  }\n</button>',
      ].join('\n'),
    );
    expect(facts.unnamedButtons).toEqual([1, 8]);
  });

  it('finds form controls without a label, and accepts every way of giving one', () => {
    const facts = accessibilityOf(
      [
        '<input name="q">',
        '<label for="email">Email</label><input id="email">',
        '<label>Name <input name="name"></label>',
        '<mat-form-field><mat-label>City</mat-label><input matInput></mat-form-field>',
        '<sci-form-field label="Mode"><select><option>a</option></select></sci-form-field>',
        '<input aria-label="Search"> <input placeholder="Search"> <input type="hidden"> <button type="submit">Go</button>',
        '<label for="pw">Password</label><input type="password" name="pw">',
        '<textarea></textarea>',
      ].join('\n'),
    );
    expect(facts.unlabelledControls).toEqual([1, 7, 8]);
  });

  it('finds tabindex above 0', () => {
    expect(accessibilityOf('<div tabindex="0"></div>\n<div tabindex="3"></div>\n<div [tabindex]="2"></div>\n<div tabindex="-1"></div>').positiveTabindex).toEqual([2, 3]);
  });

  it('reports an ungraded area with a measure per rule, inline templates on the component file lines', async () => {
    const root = writeTemp({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^20.0.0' } }),
      'src/a.component.ts': "import { Component } from '@angular/core';\n@Component({\n  selector: 'app-a',\n  template: `\n    <img src=\"x.png\">\n    <div (click)=\"go()\"></div>\n  `,\n})\nexport class AComponent {}\n",
    });
    try {
      const check = (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'accessibility')!;
      expect(check.grade).toBe('info');
      expect(Object.fromEntries(check.measures!.map((measure) => [measure.id, measure.value]))).toEqual({ 'unlabelled-controls': 0, 'unnamed-buttons': 0, 'click-without-keyboard': 1, 'images-without-alt': 1, 'positive-tabindex': 0 });
      expect(check.findings.find((finding) => finding.message.includes('alt'))?.files).toEqual([{ path: 'src/a.component.ts', line: 5 }]);
    } finally {
      removeTemp(root);
    }
  });
});
