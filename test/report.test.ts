import { renderHtml } from '../src/report/html.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderSarif } from '../src/report/sarif.js';
import { findingKind, renderCodeQuality } from '../src/report/codequality.js';
import { overallScore, topPriorities } from '../src/report/summary.js';
import { renderTerminal } from '../src/report/terminal.js';
import type { CheckResult, Report } from '../src/types.js';

/** A minimal report whose text carries everything a renderer must escape. */
function sampleReport(checks: CheckResult[]): Report {
  return {
    tool: { name: 'ng-checkup', version: '0.0.0-test' },
    generatedAt: '2026-10-19T12:00:00.000Z',
    root: '/repo',
    project: { name: '<script>alert(1)</script>', kind: 'nx', angularVersion: '22.0.0', sourceFiles: 10, templateFiles: 2, linesOfCode: 1234 },
    checks,
    durationMs: 1500,
  };
}

const poorCheck: CheckResult = {
  id: 'testing',
  title: 'Testing',
  grade: 'poor',
  summary: 'Karma | Jasmine',
  metrics: [{ label: 'Spec files', value: 3 }],
  findings: [
    { severity: 'low', message: 'A low one' },
    { severity: 'high', message: 'Uses `<img onerror>` in a message', detail: 'Detail with `code`.', files: [{ path: 'src/a.ts', line: 3 }], count: 4 },
  ],
};
const goodCheck: CheckResult = { id: 'version', title: 'Version', grade: 'good', summary: 'Fine.', metrics: [], findings: [{ severity: 'medium', message: 'A medium one' }] };
const infoCheck: CheckResult = { id: 'state', title: 'State', grade: 'info', summary: 'Nothing.', metrics: [], findings: [] };

describe('overallScore', () => {
  it('averages graded areas and leaves info areas out', () => {
    expect(overallScore(sampleReport([poorCheck, goodCheck, infoCheck]))).toBe(60);
  });

  it('is undefined when nothing could be graded', () => {
    expect(overallScore(sampleReport([infoCheck]))).toBeUndefined();
  });
});

describe('topPriorities', () => {
  it('puts high before medium across checks and never lists low findings', () => {
    expect(topPriorities(sampleReport([goodCheck, poorCheck])).map(({ finding }) => finding.message)).toEqual(['Uses `<img onerror>` in a message', 'A medium one']);
  });
});

describe('renderHtml', () => {
  const html = renderHtml(sampleReport([poorCheck, goodCheck, infoCheck]));

  it('escapes every piece of text taken from the analysed repository', () => {
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<img onerror>');
    expect(html).toContain('<code>&lt;img onerror&gt;</code>');
  });

  it('is self-contained: no external script, stylesheet, font or image', () => {
    expect(html).not.toMatch(/<script|<link|@import|url\(|src="http/i);
  });

  it('lists the remaining files beyond the examples', () => {
    expect(html).toContain('src/a.ts:3');
    expect(html).toContain('and 3 more');
  });
});

describe('renderMarkdown', () => {
  it('escapes table pipes and keeps finding text as Markdown', () => {
    const markdown = renderMarkdown(sampleReport([poorCheck]));
    expect(markdown).toContain('| Testing | Poor | Karma \\| Jasmine |');
    expect(markdown).toContain('- **High:** Uses `<img onerror>` in a message');
    expect(markdown).toContain('  - and 3 more');
  });
});

describe('renderTerminal', () => {
  const report = sampleReport([poorCheck, goodCheck, infoCheck]);

  it('writes no escape codes without colour and keeps backticks as the code marker', () => {
    const output = renderTerminal(report, { color: false, verbose: false });
    expect(output).not.toContain('\u001b[');
    expect(output).toContain('[POOR]');
    expect(output).toContain('Uses `<img onerror>` in a message');
  });

  it('colours grades when asked', () => {
    expect(renderTerminal(report, { color: true, verbose: false })).toContain('\u001b[31m');
  });

  it('lists low findings and every example file only in verbose mode', () => {
    expect(renderTerminal(report, { color: false, verbose: false })).not.toContain('A low one');
    expect(renderTerminal(report, { color: false, verbose: true })).toContain('A low one');
  });

  it('keeps the top priorities in verbose mode, after every finding', () => {
    const verbose = renderTerminal(report, { color: false, verbose: true });
    expect(verbose).toContain('Top priorities');
    expect(verbose.indexOf('A low one')).toBeLessThan(verbose.indexOf('Top priorities'));
    // The hint to --verbose is only for the short form.
    expect(verbose).not.toContain('Every finding with its files: --verbose');
  });
});

describe('renderSarif', () => {
  const sarif = () => JSON.parse(renderSarif(sampleReport([poorCheck, goodCheck, { ...goodCheck, id: 'state', findings: [{ severity: 'info', message: 'Only a hint' }] }])));

  it('is SARIF 2.1.0 with one rule per check that has something to report', () => {
    const document = sarif();
    expect(document.version).toBe('2.1.0');
    const driver = document.runs[0].tool.driver;
    expect(driver).toMatchObject({ name: 'ng-checkup', version: '0.0.0-test' });
    expect(driver.rules.map((rule: { id: string }) => rule.id)).toEqual(['testing', 'version']);
    expect(driver.rules[0]).toMatchObject({ name: 'Testing', helpUri: expect.stringContaining('checks.md#testing') });
  });

  it('gives every result a level and a location, falling back to package.json', () => {
    const results = sarif().runs[0].results;
    expect(results.map((result: { ruleId: string; level: string }) => [result.ruleId, result.level])).toEqual([
      ['testing', 'note'],
      ['testing', 'error'],
      ['version', 'warning'],
    ]);
    expect(results[0].locations[0].physicalLocation).toEqual({ artifactLocation: { uri: 'package.json', uriBaseId: '%SRCROOT%' } });
    expect(results[1].locations[0].physicalLocation).toEqual({ artifactLocation: { uri: 'src/a.ts', uriBaseId: '%SRCROOT%' }, region: { startLine: 3 } });
    expect(results[1].message.text).toBe('Uses `<img onerror>` in a message\n\nDetail with `code`.\n\n3 more locations not listed; raise --max-examples to report them all.');
  });
});

describe('renderCodeQuality', () => {
  const finding = (message: string, path: string, line?: number) => ({ severity: 'medium' as const, message, files: [{ path, ...(line ? { line } : {}) }], count: 1 });
  const entries = (checks: CheckResult[]) => JSON.parse(renderCodeQuality(sampleReport(checks))) as Array<{ fingerprint: string; severity: string; location: { path: string; lines: { begin: number } }; check_name: string }>;

  it('maps severities, puts project-wide findings on package.json and leaves info out', () => {
    const result = entries([poorCheck, goodCheck, { ...goodCheck, id: 'state', findings: [{ severity: 'info', message: 'Only a hint' }] }]);
    expect(result.map((entry) => [entry.check_name, entry.severity, entry.location.path])).toEqual([
      ['ng-checkup/testing', 'minor', 'package.json'],
      ['ng-checkup/testing', 'critical', 'src/a.ts'],
      ['ng-checkup/version', 'major', 'package.json'],
    ]);
    expect(result[1]!.location.lines.begin).toBe(3);
  });

  it('keeps a fingerprint when only the count or the line changes, so GitLab sees the same finding', () => {
    const check = (message: string, line: number): CheckResult => ({ ...goodCheck, id: 'type-safety', findings: [finding(message, 'src/a.ts', line)] });
    const before = entries([check('41 explicit `any` in application code (3.2 per 1 000 lines)', 10)])[0]!.fingerprint;
    const after = entries([check('42 explicit `any` in application code (3.3 per 1 000 lines)', 14)])[0]!.fingerprint;
    const elsewhere = entries([check('42 explicit `any` in application code (3.3 per 1 000 lines)', 14).findings[0] ? { ...check('x', 1), findings: [finding('42 explicit `any` in application code (3.3 per 1 000 lines)', 'src/b.ts', 1)] } : goodCheck])[0]!.fingerprint;
    expect(after).toBe(before);
    expect(elsewhere).not.toBe(before);
  });
});

describe('findingKind', () => {
  it('is the same finding whatever its count, singular or plural', () => {
    expect(findingKind('1 component uses eager change detection (50%)')).toBe(findingKind('2 components use eager change detection (67%)'));
    expect(findingKind('1 `@Input()` decorator and 1 `@Output()` decorator left')).toBe(findingKind('2 `@Input()` decorators and 1 `@Output()` decorator left'));
    expect(findingKind('1 file is over 500 lines')).toBe(findingKind('3 files are over 500 lines'));
    expect(findingKind('1 class injects through the constructor')).toBe(findingKind('3 classes inject through the constructor'));
    expect(findingKind('sanitization is bypassed in 1 place')).toBe(findingKind('sanitization is bypassed in 4 places'));
    expect(findingKind('Angular 15 is 7 majors behind 22')).toBe(findingKind('Angular 16 is 6 majors behind 22'));
    expect(findingKind('Strings are run as code')).not.toBe(findingKind('HTML is written into the DOM'));
  });
});
