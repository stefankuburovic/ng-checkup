import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffReports, readSavedReport } from '../src/diff.js';
import { renderDiffHtml, renderDiffMarkdown, renderDiffTerminal } from '../src/report/diff.js';
import type { CheckResult, Report } from '../src/types.js';
import { removeTemp, writeTemp } from './helpers.js';

function report(checks: Partial<CheckResult>[], overrides: Partial<Report> = {}): Report {
  return {
    tool: { name: 'ng-checkup', version: '2.1.0' },
    generatedAt: '2026-11-01T10:00:00.000Z',
    root: '/app',
    project: { name: 'shop', kind: 'angular-cli', angularVersion: '20.0.0', sourceFiles: 10, templateFiles: 5, linesOfCode: 1000 },
    checks: checks.map((check) => ({ id: 'components', title: 'Components', grade: 'fair', summary: '', metrics: [], findings: [], ...check })),
    durationMs: 1,
    ...overrides,
  };
}
const later = { generatedAt: '2026-12-01T10:00:00.000Z' };

describe('diffReports', () => {
  it('gives the score, the moved grades and the measures that moved, largest first', () => {
    const before = report([
      { id: 'components', title: 'Components', grade: 'poor', measures: [{ id: 'a', label: 'A', value: 10 }, { id: 'b', label: 'B', value: 5 }, { id: 'c', label: 'C', value: 3 }, { id: 'd', label: 'D', value: 2 }] },
      { id: 'testing', title: 'Testing', grade: 'good' },
      { id: 'bundle', title: 'Bundle', grade: 'info' },
      { id: 'state', title: 'State', grade: 'fair' },
    ]);
    const after = report(
      [
        { id: 'components', title: 'Components', grade: 'good', measures: [{ id: 'a', label: 'A', value: 4 }, { id: 'b', label: 'B', value: 4 }, { id: 'c', label: 'C', value: 3 }, { id: 'd', label: 'D', value: 7 }] },
        { id: 'testing', title: 'Testing', grade: 'fair' },
        { id: 'bundle', title: 'Bundle', grade: 'good' },
        { id: 'state', title: 'State', grade: 'fair' },
      ],
      later,
    );
    const diff = diffReports(before, after);
    expect([diff.before.score, diff.after.score]).toEqual([60, 80]);
    expect(diff.areas.map((area) => area.change)).toEqual(['better', 'worse', 'changed', 'same']);
    expect(diff.improved.map((delta) => [delta.key, delta.before, delta.after])).toEqual([['components.a', 10, 4], ['components.b', 5, 4]]);
    expect(diff.worsened.map((delta) => delta.key)).toEqual(['components.d']);
    expect(diff.unchanged).toBe(1);
    expect(diff.notes).toEqual([]);
  });

  it('matches a finding across a change of numbers and plurals, and lists what is really new or gone', () => {
    const before = report([{ findings: [{ severity: 'low', message: '1 component uses eager change detection' }, { severity: 'medium', message: 'Gone soon' }, { severity: 'info', message: 'About the run' }] }]);
    const after = report([{ findings: [{ severity: 'low', message: '12 components use eager change detection' }, { severity: 'low', message: 'Later' }, { severity: 'high', message: 'First up', files: [{ path: 'a.ts', line: 1 }], count: 1 }, { severity: 'info', message: 'Other run note' }] }], later);
    const diff = diffReports(before, after);
    expect(diff.newFindings.map((finding) => finding.message)).toEqual(['First up', 'Later']);
    expect(diff.newFindings[0]!.files).toEqual([{ path: 'a.ts', line: 1 }]);
    expect(diff.resolvedFindings.map((finding) => finding.message)).toEqual(['Gone soon']);
  });

  it('keeps a finding whose count clause comes and goes, and shows a measure two areas share once', () => {
    const shared = (value: number): CheckResult['measures'] => [{ id: 'uses', label: 'Uses', value }];
    const before = report([{ id: 'a', findings: [{ severity: 'low', message: '22 manual calls in components, 22 not tied to the lifetime' }], measures: shared(5) }, { id: 'b', measures: shared(5) }]);
    const after = report([{ id: 'a', findings: [{ severity: 'low', message: '16 manual calls in components' }], measures: shared(2) }, { id: 'b', measures: shared(2) }], later);
    const diff = diffReports(before, after);
    expect(diff.newFindings).toEqual([]);
    expect(diff.resolvedFindings).toEqual([]);
    expect(diff.improved).toHaveLength(2);
    expect(renderDiffTerminal(diff, { color: false }).match(/Uses \(5 -> 2\)/g)).toHaveLength(1);
  });

  it('never counts what one tool version does not know as worse, and says the versions differ', () => {
    const before = report([{ id: 'components', measures: [{ id: 'old', label: 'Old', value: 2 }, { id: 'gone', label: 'Gone', value: 9 }] }], { tool: { name: 'ng-checkup', version: '1.6.1' } });
    const after = report(
      [
        { id: 'components', measures: [{ id: 'old', label: 'Old', value: 2 }, { id: 'added', label: 'Added', value: 40 }] },
        { id: 'translations', title: 'Translations', grade: 'info', findings: [{ severity: 'medium', message: 'A missing key' }], measures: [{ id: 'missing', label: 'Missing keys', value: 5 }] },
      ],
      later,
    );
    const diff = diffReports(before, after);
    expect(diff.worsened).toEqual([]);
    expect(diff.improved).toEqual([]);
    expect(diff.measuresOnlyAfter).toEqual(['Added', 'Missing keys']);
    expect(diff.measuresOnlyBefore).toEqual(['Gone']);
    expect(diff.newFindings).toEqual([]);
    expect(diff.areas.find((area) => area.id === 'translations')).toMatchObject({ change: 'only-one', after: 'info' });
    expect(diff.notes[0]).toContain('different versions of the tool (1.6.1 and 2.1.0)');
    expect(diff.notes[1]).toContain('only one report');
    expect(renderDiffTerminal(diff, { color: false })).toContain('2 measures only in the "after" report, not counted as worse: Added, Missing keys.');
  });

  it('does not compare findings a --since report narrowed, and still compares the measures', () => {
    const since = { ref: 'origin/main', base: 'abc', changedFiles: 1 };
    const before = report([{ findings: [{ severity: 'low', message: 'Only before' }], measures: [{ id: 'a', label: 'A', value: 3 }] }]);
    const after = report([{ findings: [{ severity: 'low', message: 'Only after' }], measures: [{ id: 'a', label: 'A', value: 1 }] }], { ...later, since });
    const diff = diffReports(before, after);
    expect(diff.findingsCompared).toBe(false);
    expect(diff.newFindings).toEqual([]);
    expect(diff.resolvedFindings).toEqual([]);
    expect(diff.improved).toHaveLength(1);
    expect(diff.notes.join()).toContain('--since');
  });

  it('notes a different project and a swapped order', () => {
    const before = report([], { generatedAt: '2026-12-01T10:00:00.000Z' });
    const after = report([], { generatedAt: '2026-11-01T10:00:00.000Z', project: { ...report([]).project, name: 'admin' } });
    const notes = diffReports(before, after).notes.join(' ');
    expect(notes).toContain('different projects (shop and admin)');
    expect(notes).toContain('older than');
  });

  it('renders every format, escaped, with the note first', () => {
    const before = report([{ grade: 'poor', measures: [{ id: 'a', label: '<A>', value: 3 }], findings: [{ severity: 'low', message: 'Fixed `x`' }] }], { tool: { name: 'ng-checkup', version: '2.0.0' } });
    const after = report([{ grade: 'good', measures: [{ id: 'a', label: '<A>', value: 1 }], findings: [{ severity: 'medium', message: 'New `<y>`' }] }], later);
    const diff = diffReports(before, after);
    const terminal = renderDiffTerminal(diff, { color: false });
    expect(terminal).toContain('Score 20 -> 100 (+80)');
    expect(terminal).toContain('poor -> good');
    expect(terminal).toContain('-2  <A> (3 -> 1)');
    expect(terminal.indexOf('note')).toBeLessThan(terminal.indexOf('Score'));
    const markdown = renderDiffMarkdown(diff);
    expect(markdown).toContain('| <A> | 3 | 1 | -2 |');
    expect(markdown).toContain('- **medium** New `<y>` (Components)');
    expect(markdown).toContain('**Note:**');
    const html = renderDiffHtml(diff);
    expect(html).toContain('&lt;A&gt;');
    expect(html).toContain('<code>&lt;y&gt;</code>');
    expect(html).not.toContain('<A>');
  });
});

describe('readSavedReport', () => {
  it('reads a saved report and refuses anything else', () => {
    const root = writeTemp({ 'ok.json': JSON.stringify(report([])), 'quality.json': '[]', 'baseline.json': JSON.stringify({ version: 1, measures: {} }), 'broken.json': '{' });
    try {
      expect(readSavedReport(join(root, 'ok.json')).project.name).toBe('shop');
      expect(() => readSavedReport(join(root, 'quality.json'))).toThrow('not an ng-checkup JSON report');
      expect(() => readSavedReport(join(root, 'baseline.json'))).toThrow('not an ng-checkup JSON report');
      expect(() => readSavedReport(join(root, 'broken.json'))).toThrow('Cannot read');
      expect(() => readSavedReport(join(root, 'missing.json'))).toThrow('Cannot read');
    } finally {
      removeTemp(root);
    }
  });
});

describe('ng-checkup diff', () => {
  const cli = join(process.cwd(), 'dist', 'cli.js');

  it('prints the comparison, writes the reports and exits 0 even when things got worse', () => {
    const root = writeTemp({
      'a.json': JSON.stringify(report([{ measures: [{ id: 'a', label: 'A', value: 1 }] }])),
      'b.json': JSON.stringify(report([{ measures: [{ id: 'a', label: 'A', value: 9 }] }], later)),
    });
    try {
      const out = execFileSync('node', [cli, 'diff', join(root, 'a.json'), join(root, 'b.json'), '--report', join(root, 'out/d.html'), '--report', join(root, 'out/d.md'), '--report', join(root, 'out/d.json')], { encoding: 'utf8' });
      expect(out).toContain('+8  A (1 -> 9)');
      expect(readFileSync(join(root, 'out/d.html'), 'utf8')).toContain('<!doctype html>');
      expect(existsSync(join(root, 'out/d.md'))).toBe(true);
      expect(JSON.parse(readFileSync(join(root, 'out/d.json'), 'utf8')).worsened).toHaveLength(1);
      expect(JSON.parse(execFileSync('node', [cli, 'diff', join(root, 'a.json'), join(root, 'b.json'), '--json'], { encoding: 'utf8' })).worsened[0].after).toBe(9);
    } finally {
      removeTemp(root);
    }
  });

  it('exits 2 on wrong arguments', () => {
    expect(spawnSync('node', [cli, 'diff', 'only-one.json']).status).toBe(2);
    expect(spawnSync('node', [cli, 'diff', 'a.json', 'b.json', '--report', 'x.sarif']).status).toBe(2);
    expect(spawnSync('node', [cli, 'diff', 'nope-a.json', 'nope-b.json']).status).toBe(2);
  });
});
