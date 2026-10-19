import { renderHtml } from '../src/report/html.js';
import { renderMarkdown } from '../src/report/markdown.js';
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
});
