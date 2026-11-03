import { runCheckup } from '../src/index.js';
import { colorLinesIn, colorLinesInTemplate, isTokenFile } from '../src/stylesheets.js';
import { removeTemp, writeTemp } from './helpers.js';

describe('colour literals outside the tokens', () => {
  it('counts colours in colour declarations, not token definitions, comments, transitions or urls', () => {
    const lines = colorLinesIn(
      [
        ':root { --brand: #0b5; }', // 1: a token definition
        '$accent: rgba(0, 0, 0, .5);', // 2: a SCSS variable
        '.a { color: #fff; background: var(--brand); }', // 3: one literal
        '.b {', // 4
        '  border: 1px solid rgba(0, 0, 0, 0.1);', // 5
        '  transition: color .2s;', // 6
        "  background-image: url('#fff.svg');", // 7
        '  /* color: red; */', // 8
        '  box-shadow: 0 0 2px black, 0 0 4px #000;', // 9: two
        '}',
        'li:first-child { color: white }', // 11
        '.c { width: 10px; }',
      ].join('\n'),
    );
    expect(lines).toEqual([3, 5, 9, 9, 11]);
  });

  it('reads inline styles and style bindings in templates', () => {
    expect(colorLinesInTemplate(`<div style="color: red; width: 1px"></div>\n<p [style.background-color]="'#eee'" [style.width]="'1px'"></p>\n<b [style.color]="tone"></b>`)).toEqual([1, 2]);
  });

  it('skips files named for the tokens', () => {
    expect(['_tokens.scss', 'variables.less', 'theme.css', 'src/styles/_colors.scss', 'palette.dark.scss'].map(isTokenFile)).toEqual([true, true, true, true, true]);
    expect(['app.component.scss', 'themed-button.scss'].map(isTokenFile)).toEqual([false, false]);
  });

  it('reports them in the components area without touching its grade', async () => {
    const root = writeTemp({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^20.0.0' } }),
      'src/_tokens.scss': '.x { color: #fff; }',
      'src/app/a.component.scss': '.a { color: #fff; }\n.b { color: var(--text); }',
      'src/app/a.component.html': '<p style="color: black"></p>',
      'src/app/a.component.ts': "import { Component } from '@angular/core';\n@Component({ selector: 'app-a', templateUrl: './a.component.html' })\nexport class AComponent {}\n",
    });
    try {
      const components = (await runCheckup(root, { offline: true })).checks.find((check) => check.id === 'components')!;
      expect(components.measures?.find((measure) => measure.id === 'hardcoded-colors')?.value).toBe(2);
      expect(components.findings.find((finding) => finding.message.includes('colour'))?.files).toEqual([
        { path: 'src/app/a.component.scss', line: 1 },
        { path: 'src/app/a.component.html', line: 1 },
      ]);
    } finally {
      removeTemp(root);
    }
  });
});
