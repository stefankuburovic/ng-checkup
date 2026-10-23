import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHistoryArguments, renderHistoryForFile } from '../src/cli.js';
import { collectHistory, HistoryUnavailableError, movedMeasures } from '../src/history.js';
import { renderHistoryHtml, renderHistoryTerminal } from '../src/report/history.js';
import { removeTemp, writeTemp } from './helpers.js';

/** A component whose template has `uses` legacy `*ngIf`s: the measure the history follows. */
function component(uses: number): string {
  const template = Array.from({ length: uses }, (_, index) => `<p *ngIf="flag${index}">${index}</p>`).join('');
  return `import { Component } from '@angular/core';\n@Component({ selector: 'app-root', standalone: true, template: \`${template}\` })\nexport class AppComponent {}\n`;
}

/** The 15th of the month `monthsBack` months before now, at noon, as git reads a date. */
function midMonth(monthsBack: number): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - monthsBack, 15, 12).toISOString();
}

/**
 * A repository with one commit in each of the given months back, each
 * setting the number of legacy `*ngIf`s, so every point of the history has a
 * known value.
 */
function repository(commits: Array<{ monthsBack: number; uses: number }>): string {
  const root = writeTemp({ 'package.json': JSON.stringify({ name: 'shop', dependencies: { '@angular/core': '17.3.0' } }), 'src/app.component.ts': component(0) });
  for (const entry of commits) {
    const date = midMonth(entry.monthsBack);
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore', env });
    if (entry === commits[0]) git('init', '-q');
    writeFileSync(join(root, 'src/app.component.ts'), component(entry.uses));
    git('add', '.');
    git('commit', '-q', '-m', `uses ${entry.uses}`);
  }
  return root;
}

describe('history', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) removeTemp(root);
    root = undefined;
  });

  it('checks one commit per month, skips months without a new commit, and ends with the working tree', async () => {
    root = repository([
      { monthsBack: 5, uses: 9 },
      { monthsBack: 3, uses: 6 },
      { monthsBack: 1, uses: 4 },
    ]);
    // Uncommitted work counts: the last point is the working tree as it is.
    writeFileSync(join(root, 'src/app.component.ts'), component(1));
    const progress: string[] = [];
    const report = await collectHistory(root, { points: 6, onProgress: (done, total, label) => progress.push(`${done}/${total} ${label}`) });

    expect(report.points.map((point) => point.measures['components.legacy-control-flow'])).toEqual([9, 6, 4, 1]);
    expect(report.points.map((point) => point.date)).toEqual([midMonth(5).slice(0, 10), midMonth(3).slice(0, 10), midMonth(1).slice(0, 10), new Date().toISOString().slice(0, 10)]);
    expect(report.points.at(-1)?.commit).toBe('working tree');
    expect(report.points[0]?.angularVersion).toBe('17.3.0');
    expect(progress).toHaveLength(4);
    expect(progress.at(-1)).toBe('3/4 working tree');
    // The working tree itself is untouched by the checkouts.
    expect(readFileSync(join(root, 'src/app.component.ts'), 'utf8')).toBe(component(1));

    const moved = movedMeasures(report);
    expect(moved.find((entry) => entry.key === 'components.legacy-control-flow')).toMatchObject({ first: 9, last: 1 });
    expect(renderHistoryTerminal(report, { color: false })).toContain('-8  *ngIf / *ngFor / [ngSwitch] uses (9 -> 1)');
  });

  it('renders HTML with an inline chart, Markdown and JSON, by extension', async () => {
    root = repository([
      { monthsBack: 2, uses: 3 },
      { monthsBack: 1, uses: 2 },
    ]);
    const report = await collectHistory(root, { points: 3 });
    const html = renderHistoryForFile(report, 'history.html');
    expect(html).toContain('<svg viewBox="0 0 640 170"');
    expect(html).toContain('<svg viewBox="0 0 420 170"');
    expect(html).toContain('*ngIf / *ngFor / [ngSwitch] uses (-1)');
    expect(html).not.toMatch(/<script|https?:\/\/(?!www\.w3\.org)/);
    expect(renderHistoryForFile(report, 'history.md')).toContain('| *ngIf / *ngFor / [ngSwitch] uses | 3 | 2 | -1 |');
    // The month before last, then HEAD as the clean working tree: HEAD is not counted twice.
    expect(JSON.parse(renderHistoryForFile(report, 'history.json')).points).toHaveLength(2);
  });

  it('places points by date, so a long pause without commits shows as one', () => {
    const point = (date: string, score: number) => ({ commit: date, date, score, linesOfCode: 1, measures: {} });
    const html = renderHistoryHtml({ tool: { name: 'ng-checkup', version: 'test' }, generatedAt: '2026-10-23T00:00:00Z', root: 'app', labels: {}, points: [point('2023-10-30', 60), point('2024-05-24', 68), point('2026-10-23', 91)] });
    const xs = [...html.matchAll(/<circle cx="([\d.]+)"/g)].map((match) => Number(match[1]));
    // 207 of the 1 089 days fall between the first two points: about a fifth of the 580-unit axis, not half.
    expect(xs).toEqual([44, 44 + Math.round((207 / 1089) * 580 * 10) / 10, 624]);
    // Three years read by year, and the last point is "now".
    expect([...html.matchAll(/y="160" text-anchor="(?:middle|end)">([^<]+)</g)].map((match) => match[1])).toEqual(['2024', '2025', '2026', 'now']);
  });

  it('refuses outside git and in a shallow clone, saying what to do', async () => {
    root = writeTemp({ 'package.json': '{}' });
    await expect(collectHistory(root)).rejects.toThrow(HistoryUnavailableError);
    const source = repository([
      { monthsBack: 2, uses: 1 },
      { monthsBack: 1, uses: 0 },
    ]);
    const shallow = writeTemp({});
    try {
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${source}`, shallow], { stdio: 'ignore' });
      await expect(collectHistory(shallow)).rejects.toThrow('fetch-depth: 0');
    } finally {
      removeTemp(source);
      removeTemp(shallow);
    }
  });

  it('parses its arguments', () => {
    const folder = writeTemp({});
    root = folder;
    expect(parseHistoryArguments([folder, '--points', '6', '-r', 'h.html'], {}, false)).toMatchObject({ root: folder, points: 6, json: false, color: false });
    expect(() => parseHistoryArguments([folder, '--points', '0'], {}, false)).toThrow('--points takes a whole number from 1 to 60');
    expect(() => parseHistoryArguments([folder, '--report', 'h.sarif'], {}, false)).toThrow('Unknown history format');
  });
});
