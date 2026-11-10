import { describe, expect, it } from 'vitest';
import { parseCliArguments } from '../src/cli.js';
import { detectEditor, editorUrl } from '../src/report/editor.js';
import { renderHtml } from '../src/report/html.js';
import { formatDate, OVERVIEW_CHANGE_LIMIT } from '../src/report/overview.js';
import type { CheckResult, Grade, ProjectSummary, Report } from '../src/types.js';

const IDS = ['version', 'deprecated-apis', 'dependencies', 'change-detection', 'components', 'state', 'architecture', 'testing', 'type-safety', 'security', 'translations', 'accessibility', 'ssr', 'circular-deps', 'bundle'];

/** Fifteen areas with the given grades, in the fixed order; extra fields per area through `patch`. */
function checks(grades: Grade[], patch: Partial<Record<string, Partial<CheckResult>>> = {}): CheckResult[] {
  return IDS.map((id, index) => ({ id, title: `Area ${id}`, grade: grades[index] ?? 'info', summary: `Summary of ${id}.`, metrics: [], findings: [], measures: [{ id: 'm', label: `${id} measure`, value: 1 }], ...patch[id] }));
}

function report(overrides: Partial<Report>): Report {
  return {
    tool: { name: 'ng-checkup', version: '0.0.0-test' },
    generatedAt: '2026-11-10T12:00:00.000Z',
    root: '/Users/dev/app',
    project: { name: 'app', kind: 'angular-cli', angularVersion: '22.0.0', sourceFiles: 10, templateFiles: 2, linesOfCode: 1234 },
    checks: checks([]),
    durationMs: 1,
    ...overrides,
  };
}

/** True when some `<a>` opens before the previous one closed. */
function hasNestedLinks(html: string): boolean {
  let depth = 0;
  // The stylesheet's comments mention <a>; only the markup counts.
  for (const tag of html.slice(html.indexOf('<body>')).match(/<a[\s>]|<\/a>/g) ?? []) {
    depth += tag === '</a>' ? -1 : 1;
    if (depth > 1) return true;
  }
  return false;
}

const overviewOf = (html: string): string => html.slice(html.indexOf('<section class="ov"'), html.indexOf('</section>\n', html.lastIndexOf('class="ov-changes"')));

describe('the HTML overview', () => {
  const godata = report({
    checks: checks(['poor', 'good', 'info', 'poor', 'poor', 'fair', 'fair', 'poor', 'poor', 'poor', 'info', 'info', 'info', 'fair', 'info']),
    baseline: {
      path: 'b.json',
      updated: '2026-08-10',
      score: 36,
      grades: { security: 'fair', architecture: 'poor' },
      regressions: [{ key: 'security.m', check: 'Security', label: 'Sanitizer bypasses', before: 9, after: 12 }],
      improvements: [{ key: 'type-safety.m', check: 'Type safety', label: 'Explicit any', before: 1012, after: 943 }],
      added: [],
    },
  });
  const html = renderHtml(godata);

  it('shows the score, its band as shape and word, and its move since the baseline', () => {
    expect(html).toContain('<span class="ov-score-value">40</span>');
    expect(html).toContain('<div class="ov-score g-poor">');
    expect(html).toContain('<span class="ov-glyph" aria-hidden="true"></span>Poor</p>');
    expect(html).toMatch(/data-dir="better"><span class="ov-judge"><span class="ov-dir" aria-hidden="true"><\/span>Better<\/span><span>\+4 since 10 Aug 2026, was 36<\/span>/);
    expect(html).toContain('style="left:36%"');
    expect(html).toContain('Poor, 4 points up since Aug 2026. 6 of the 10 graded areas are poor, and Area security slipped from fair to poor.');
  });

  it('lists the areas worst first, each a link with its grade word and its baseline grade when that changed', () => {
    const order = [...html.matchAll(/<li class="ov-area g-(\w+)" id="ov-([\w-]+)">/g)].map((match) => match[1]);
    expect(order).toEqual([...order].sort((left, right) => ['poor', 'fair', 'good', 'info'].indexOf(left!) - ['poor', 'fair', 'good', 'info'].indexOf(right!)));
    expect(order).toHaveLength(15);
    expect(html).toContain('<a class="ov-area-name" href="#security">Area security</a>');
    expect(html).toMatch(/id="ov-security">.*<span class="ov-area-change" data-dir="worse">.*was Fair<\/span>/);
    expect(html).toMatch(/id="ov-architecture">.*<span class="ov-area-change" data-dir="better">.*was Poor<\/span>/);
  });

  it('links every tally card with a count to the first area of its grade', () => {
    expect(html).toContain('<li class="ov-tally-item g-poor" data-count="6"><a class="ov-tally-link" href="#ov-version">');
    expect(html).toContain('<li class="ov-tally-item g-good" data-count="1"><a class="ov-tally-link" href="#ov-deprecated-apis">');
  });

  it('lists the changed measures worse first, with aligned numbers and the word for the direction', () => {
    expect(html).toContain('5 area');
    const changes = html.slice(html.indexOf('class="ov-change-list"'));
    expect(changes.indexOf('Sanitizer bypasses')).toBeLessThan(changes.indexOf('Explicit any'));
    expect(changes).toContain('<a class="ov-change-name" href="#security">Sanitizer bypasses</a>');
    expect(changes).toContain('<span class="ov-before">1\u202F012</span>');
    expect(changes).toContain('<span class="ov-change-diff">−69</span>');
    expect(html).toContain('1 worse · 1 better · 13 unchanged');
  });

  it('never nests a link in a link, and stays self-contained', () => {
    expect(hasNestedLinks(html)).toBe(false);
    expect(html).not.toMatch(/<script|<link|@import|url\(|src="http/i);
  });

  it('takes its layout from the overview option', () => {
    expect(renderHtml(godata, { overview: 'tiles' })).toContain('<section class="ov" id="overview" data-variant="tiles"');
  });

  it('says it is the first run when there is no baseline, and has nothing to link for an empty grade', () => {
    const clean = renderHtml(report({ checks: checks(['good', 'good', 'good', 'good', 'good', 'good', 'good', 'good', 'good', 'good', 'info', 'good', 'info', 'good', 'info']) }));
    expect(clean).toContain('<span class="ov-score-value">100</span>');
    expect(clean).toContain('First run</span><span>No baseline yet</span>');
    expect(clean).toContain('<p class="ov-empty">No baseline yet. Run <code>ng-checkup baseline</code>');
    expect(clean).toContain('data-count="0"><span class="ov-tally-link">');
    expect(clean).toContain('Every graded area is good.');
  });

  it('flags a score built on few areas, as for an AngularJS app', () => {
    const legacy = renderHtml(report({ checks: checks(['poor', 'info', 'info', 'info', 'info', 'info', 'fair', 'poor']) }));
    expect(legacy).toContain('data-coverage="low"');
    expect(legacy).toContain('Only 3 of 15 areas apply, so read the score as a rough signal.');
    expect(legacy).toContain('<span class="ov-score-value">33</span>');
  });

  it('adds the projects of a monorepo, worst first, each linking to its row in the table', () => {
    const projects: ProjectSummary[] = Array.from({ length: 12 }, (_, index) => ({ name: `app-${index}`, root: `apps/app-${index}`, type: 'application', sourceFiles: 10, linesOfCode: 100, score: 20 + index * 7, grades: {}, highFindings: 0, measures: {} }));
    const mono = renderHtml(report({ project: { name: 'acme', kind: 'nx', sourceFiles: 10, templateFiles: 2, linesOfCode: 1234 }, projects }));
    expect(mono.match(/<li class="ov-project g-/g)).toHaveLength(12);
    expect(mono).toContain('href="#project-app-0"');
    expect(mono).toContain('<tr id="project-app-0">');
    expect(mono).toContain('<span class="ov-path-dir">apps/<wbr></span><span class="ov-path-file">app-0</span>');
    expect(mono).toContain('12 projects');
  });

  it('caps the change list and links to the full list below', () => {
    const regressions = Array.from({ length: 12 }, (_, index) => ({ key: `components.m${index}`, check: 'Components', label: `Measure ${index}`, before: 1204, after: 1504 }));
    const busy = renderHtml(report({ baseline: { path: 'b.json', regressions, improvements: [], added: [] } }));
    expect(overviewOf(busy).match(/<li class="ov-change"/g)).toHaveLength(OVERVIEW_CHANGE_LIMIT);
    expect(busy).toContain('<a href="#changes">And 4 more changes in the full list</a>');
    expect(busy).toContain('<section id="changes"');
    expect(busy).toContain('<span class="ov-change-diff">+300</span>');
  });

  it('links finding files to the editor at their line, breaking a long path after every slash', () => {
    const long = 'libs/feature-identity-verification/src/lib/components/document capture/document-capture-camera-preview-overlay.component.ts';
    const files = Array.from({ length: 5 }, (_, index) => ({ path: index === 0 ? long : `src/f${index}.ts`, line: 172 }));
    const deep = renderHtml(report({ checks: checks(['poor'], { version: { findings: [{ severity: 'high', message: 'Lots', files, count: 300 }] } }) }));
    expect(deep).toContain(`href="vscode://file/Users/dev/app/libs/feature-identity-verification/src/lib/components/document%20capture/document-capture-camera-preview-overlay.component.ts:172"`);
    expect(deep).toContain('components/<wbr>document capture/<wbr></span><span class="ov-path-file">document-capture-camera-preview-overlay.component.ts:172</span>');
    expect(deep).toContain('and 295 more');
    expect(renderHtml(report({ checks: checks(['poor'], { version: { findings: [{ severity: 'high', message: 'x', files: [{ path: 'a.ts' }] }] } }) }), { editor: 'none' })).not.toContain('href="vscode:');
    expect(hasNestedLinks(deep)).toBe(false);
  });
});

describe('files past the examples', () => {
  const many = (n: number) => Array.from({ length: n }, (_, index) => ({ path: `src/f${index}.ts`, line: index + 1 }));
  const withFiles = (files: { path: string; line: number }[], count: number) => report({ checks: checks(['poor'], { version: { findings: [{ severity: 'high', message: 'Lots', files, count }] } }) });

  it('fold behind "and N more", which opens the next batch of 50, and so on', () => {
    const html = renderHtml(withFiles(many(120), 120), { examples: 5 });
    const list = html.slice(html.indexOf('<ul class="files">'), html.indexOf('</li>\n      </ul>', html.indexOf('<ul class="files">')));
    expect(list.match(/href="vscode:/g)).toHaveLength(120);
    expect([...list.matchAll(/<summary>and (\d+) more<\/summary>/g)].map((match) => match[1])).toEqual(['115', '65', '15']);
    // The first five show, the sixth is inside the first disclosure.
    expect(list.indexOf('f4.ts')).toBeLessThan(list.indexOf('<details>'));
    expect(list.indexOf('f5.ts')).toBeGreaterThan(list.indexOf('<details>'));
    expect(hasNestedLinks(html)).toBe(false);
  });

  it('name the files a capped report counted but does not have, after the ones it has', () => {
    const html = renderHtml(withFiles(many(60), 300), { examples: 5 });
    expect([...html.matchAll(/<summary>and (\d+) more<\/summary>/g)].map((match) => match[1])).toEqual(['295', '245']);
    expect(html).toContain('<li class="more">and 240 more</li>');
  });

  it('stay as before when the report holds only the examples', () => {
    const html = renderHtml(withFiles(many(5), 300));
    expect(html).not.toContain('<details>');
    expect(html).toContain('<li class="more">and 295 more</li>');
  });
});

describe('the contents column', () => {
  const html = renderHtml(report({ checks: checks(['poor', 'good']) }));

  it('lists the sections and every area with its grade, each a link to it', () => {
    const nav = html.slice(html.indexOf('<nav class="toc"'), html.indexOf('</nav>'));
    expect(nav).toContain('<a href="#overview">Overview</a>');
    expect(nav).toContain('<li class="g-poor"><a href="#version"><span class="ov-glyph" aria-hidden="true"></span><span>Area version</span><span class="ov-vh">, Poor</span></a></li>');
    expect(nav.match(/<li class="g-/g)).toHaveLength(15);
    expect(html).toContain('<section class="ov" id="overview"');
    // Every link has its target on the page.
    for (const [, id] of nav.matchAll(/href="#([^"]+)"/g)) expect(html).toContain(`id="${id}"`);
  });

  it('marks the entry of the section a click went to, without a script', () => {
    expect(html).toContain('body:has(#version:target) .toc a[href="#version"]');
    expect(html).not.toMatch(/<script/i);
  });
});

describe('editor links', () => {
  const ref = { path: 'src/app/a b.ts', line: 7 };

  it('builds each editor’s URL from the absolute path', () => {
    expect(editorUrl('cursor', '/repo', ref)).toBe('cursor://file/repo/src/app/a%20b.ts:7');
    expect(editorUrl('idea', '/repo', ref)).toBe('idea://open?file=%2Frepo%2Fsrc%2Fapp%2Fa%20b.ts&line=7');
    expect(editorUrl('file', '/repo', ref)).toBe('file:///repo/src/app/a%20b.ts');
    expect(editorUrl('vscode', 'C:\\work\\app', { path: 'src/x.ts' })).toBe('vscode://file/C:/work/app/src/x.ts');
  });

  it('gives no link without an absolute root or with none', () => {
    expect(editorUrl('vscode', 'github:owner/repo', ref)).toBeUndefined();
    expect(editorUrl('none', '/repo', ref)).toBeUndefined();
  });

  it('picks the editor from the environment, and none on CI', () => {
    expect(detectEditor({})).toBe('vscode');
    expect(detectEditor({ NG_CHECKUP_EDITOR: 'WebStorm' })).toBe('webstorm');
    expect(detectEditor({ CI: 'true' })).toBe('none');
    expect(detectEditor({ TERMINAL_EMULATOR: 'JetBrains-JediTerm' })).toBe('idea');
  });

  it('is set and checked on the command line, with the overview layout', () => {
    const parsed = parseCliArguments(['--editor', 'idea', '--overview', 'ledger'], {}, false);
    expect(parsed).toMatchObject({ editor: 'idea', overview: 'ledger' });
    expect(() => parseCliArguments(['--editor', 'notepad'], {}, false)).toThrow(/--editor takes/);
    expect(() => parseCliArguments(['--overview', 'grid'], {}, false)).toThrow(/--overview takes/);
  });
});

describe('formatDate', () => {
  it('writes an ISO date the way the overview shows it', () => {
    expect(formatDate('2026-08-10')).toBe('10 Aug 2026');
    expect(formatDate('soon')).toBe('soon');
  });
});
