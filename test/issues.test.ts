import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isReportPath } from '../src/config.js';
import { capExamples, isIssuesReport, renderIssuesCsv, renderIssuesMarkdown } from '../src/report/issues.js';
import type { CheckResult, Finding, Report } from '../src/types.js';
import { removeTemp, writeTemp } from './helpers.js';

const report = (findings: Finding[], overrides: Partial<CheckResult> = {}, extra: Partial<Report> = {}): Report => ({
  tool: { name: 'ng-checkup', version: '2.1.0' },
  generatedAt: '2026-11-06T10:00:00.000Z',
  root: '/app',
  project: { name: 'shop', kind: 'angular-cli', sourceFiles: 1, templateFiles: 0, linesOfCode: 1 },
  checks: [{ id: 'components', title: 'Components & templates', grade: 'fair', summary: '', metrics: [], findings, ...overrides }],
  durationMs: 1,
  ...extra,
});

/** RFC 4180, as a spreadsheet reads it. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index++;
      } else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\r' && text[index + 1] === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      index++;
    } else value += character;
  }
  return rows;
}

const manyFiles = (count: number): { path: string; line: number }[] => Array.from({ length: count }, (_, index) => ({ path: `src/f${index}.ts`, line: index + 1 }));

describe('the backlog as CSV', () => {
  it('has one row per finding about the code, most urgent first, in columns Jira can map', () => {
    const rows = parseCsv(
      renderIssuesCsv(
        report([
          { severity: 'low', message: '2 `*ngFor` loops without `trackBy`', detail: 'Why it matters, "quoted".\nSecond line, with a comma.', files: [{ path: 'a.html', line: 3 }, { path: 'b.html' }], count: 2 },
          { severity: 'info', message: 'About the run' },
          { severity: 'high', message: 'First up' },
        ]),
      ),
    );
    expect(rows[0]).toEqual(['Summary', 'Priority', 'Labels', 'Description', 'Area', 'Files', 'Fingerprint', 'Issue Type']);
    expect(rows).toHaveLength(3);
    expect(rows[1]!.slice(0, 5)).toEqual(['First up', 'High', 'ng-checkup-components', '', 'Components & templates']);
    expect(rows[2]![0]).toBe('2 *ngFor loops without trackBy');
    expect(rows[2]![1]).toBe('Low');
    expect(rows[2]![3]).toBe('Why it matters, "quoted".\nSecond line, with a comma.\n\nFiles:\na.html:3\nb.html');
    expect(rows[2]![5]).toBe('a.html:3\nb.html');
    expect(rows[2]![6]).toMatch(/^[0-9a-f]{16}$/);
    expect(rows.slice(1).map((row) => row[7])).toEqual(['Task', 'Task']);
  });

  it('keeps a spreadsheet from running a cell as a formula', () => {
    const rows = parseCsv(renderIssuesCsv(report([{ severity: 'low', message: '=HYPERLINK("http://evil","x")', detail: '@SUM(1)', files: [{ path: '+cmd.ts' }] }])));
    expect(rows[1]![0]).toBe(`'=HYPERLINK("http://evil","x")`);
    expect(rows[1]![3]!.startsWith(`'@SUM(1)`)).toBe(true);
    expect(rows[1]![5]).toBe(`'+cmd.ts`);
    for (const start of ['-', '\t']) expect(parseCsv(renderIssuesCsv(report([{ severity: 'low', message: `${start}x` }])))[1]![0]).toBe(`'${start}x`);
  });

  it('lists every file, and says what is left out only past the limit of a cell', () => {
    const all = parseCsv(renderIssuesCsv(report([{ severity: 'low', message: 'Many', files: manyFiles(500), count: 500 }])))[1]!;
    expect(all[5]!.split('\n')).toHaveLength(500);
    const huge = parseCsv(renderIssuesCsv(report([{ severity: 'low', message: 'Huge', files: manyFiles(5000), count: 5000 }])))[1]!;
    expect(huge[5]!.length).toBeLessThanOrEqual(32_767);
    expect(huge[3]!.length).toBeLessThanOrEqual(32_767);
    expect(huge[5]).toMatch(/\.\.\. and \d+ more; the \.issues\.md and \.json reports list them all$/);
    const kept = huge[5]!.split('\n').length - 1;
    expect(huge[5]).toContain(`and ${5000 - kept} more`);
  });

  it('gives a finding the same fingerprint whatever its count', () => {
    const fingerprint = (message: string): string => parseCsv(renderIssuesCsv(report([{ severity: 'low', message }])))[1]![6]!;
    expect(fingerprint('1 component uses eager change detection')).toBe(fingerprint('12 components use eager change detection'));
    expect(fingerprint('22 manual calls, 22 not tied')).toBe(fingerprint('16 manual calls'));
    expect(fingerprint('Something')).not.toBe(fingerprint('Something else'));
  });

  it('is only the header without findings', () => {
    expect(parseCsv(renderIssuesCsv(report([{ severity: 'info', message: 'About the run' }])))).toHaveLength(1);
  });
});

describe('the backlog as Markdown', () => {
  it('is a checklist with the fingerprint out of sight, and folds a long list without cutting it', () => {
    const markdown = renderIssuesMarkdown(report([{ severity: 'low', message: 'Short `x`', detail: 'Why.', files: manyFiles(2) }, { severity: 'medium', message: 'Long', files: manyFiles(40), count: 40 }, { severity: 'info', message: 'About the run' }]));
    expect(markdown).toContain('2 items, most urgent first.');
    expect(markdown).toMatch(/- \[ \] \*\*medium\*\* Long \(Components & templates\) <!-- ng-checkup:[0-9a-f]{16} -->/);
    expect(markdown).toContain('<details><summary>40 files</summary>');
    expect(markdown).toContain('`src/f39.ts:40`');
    expect(markdown.indexOf('Long')).toBeLessThan(markdown.indexOf('Short'));
    expect(markdown).toContain('  Why.');
    expect(markdown).not.toContain('About the run');
  });

  it('says when a --since run narrowed it', () => {
    expect(renderIssuesMarkdown(report([], {}, { since: { ref: 'origin/main', base: 'abc', changedFiles: 2 } }))).toContain('changed since origin/main');
  });
});

describe('capExamples', () => {
  it('cuts the files, keeps the count and leaves its argument alone', () => {
    const full = report([{ severity: 'low', message: 'Many', files: manyFiles(9), count: 9 }]);
    const capped = capExamples(full, 5).checks[0]!.findings[0]!;
    expect(capped.files).toHaveLength(5);
    expect(capped.count).toBe(9);
    expect(full.checks[0]!.findings[0]!.files).toHaveLength(9);
  });
});

describe('the file names', () => {
  it('needs the .issues suffix: a plain .csv names no format', () => {
    expect(isIssuesReport('out/x.issues.csv')).toBe(true);
    expect(isIssuesReport('x.issues.md')).toBe(true);
    expect(isIssuesReport('x.md')).toBe(false);
    expect(isReportPath('x.issues.csv')).toBe(true);
    expect(isReportPath('x.csv')).toBe(false);
  });
});

describe('a run with a backlog export', () => {
  it('lists every file there and still caps the other reports', () => {
    const components = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`src/c${index}.component.ts`, `import { Component } from '@angular/core';\n@Component({ selector: 'app-c${index}', template: '<img src="x.png">' })\nexport class C${index}Component {}\n`]));
    const root = writeTemp({ 'package.json': JSON.stringify({ dependencies: { '@angular/core': '^20.0.0' } }), ...components });
    try {
      execFileSync('node', [join(process.cwd(), 'dist', 'cli.js'), root, '--offline', '--report', join(root, 'out/x.issues.csv'), '--report', join(root, 'out/x.issues.md'), '--report', join(root, 'out/x.json')], { encoding: 'utf8' });
      const row = parseCsv(readFileSync(join(root, 'out/x.issues.csv'), 'utf8')).find((entry) => entry[0]!.includes('without alt'))!;
      expect(row[5]!.split('\n')).toHaveLength(8);
      expect(readFileSync(join(root, 'out/x.issues.md'), 'utf8')).toContain('<details><summary>8 files</summary>');
      const finding = (JSON.parse(readFileSync(join(root, 'out/x.json'), 'utf8')) as Report).checks.flatMap((check) => check.findings).find((entry) => entry.message.includes('without `alt`'))!;
      expect(finding.files).toHaveLength(5);
      expect(finding.count).toBe(8);
    } finally {
      removeTemp(root);
    }
  });
});
