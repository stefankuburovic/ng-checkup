import { formatCount } from '../checks/context.js';
import type { HistoryPoint, HistoryReport } from '../history.js';
import { change, CHART_STYLES, historyCharts, movedMeasures } from './charts.js';
import { escape } from './escape.js';
import { STYLES } from './html.js';
import { palette } from './terminal.js';

/** A point's commit as the reports show it: seven characters, or `working tree`. */
function shortCommit(point: HistoryPoint): string {
  return point.commit === 'working tree' ? 'now' : point.commit.slice(0, 7);
}


/**
 * `ng-checkup history` for a terminal: one line per point (date, commit,
 * Angular, score, lines of code), then the measures that moved the most
 * between the first point and now.
 */
export function renderHistoryTerminal(report: HistoryReport, options: { color: boolean }): string {
  const c = palette(options.color);
  const lines = [`${c.bold(report.tool.name)} ${c.dim(report.tool.version)}  ${c.bold('history')} ${c.dim(`of ${report.root}, ${report.points.length} points`)}`, ''];
  lines.push(c.dim(`  ${'date'.padEnd(11)} ${'commit'.padEnd(8)} ${'Angular'.padEnd(9)} ${'score'.padStart(5)} ${'lines'.padStart(9)}`));
  for (const point of report.points) {
    const score = point.score === undefined ? '-' : String(point.score);
    lines.push(`  ${point.date.padEnd(11)} ${c.dim(shortCommit(point).padEnd(8))} ${(point.angularVersion ?? '-').padEnd(9)} ${c.bold(score.padStart(5))} ${formatCount(point.linesOfCode).padStart(9)}`);
  }
  const moved = movedMeasures(report);
  lines.push('');
  if (moved.length === 0) lines.push(`  ${c.dim('No measure moved between the first point and now.')}`);
  else {
    lines.push(c.bold('Moved most since the first point'));
    // A measure counts debt, so a falling number is progress.
    for (const entry of moved) lines.push(`  ${(entry.last < entry.first ? c.green : c.red)(change(entry.first, entry.last).padStart(7))}  ${entry.label} ${c.dim(`(${formatCount(entry.first)} -> ${formatCount(entry.last)})`)}`);
  }
  return lines.join('\n');
}

/** `ng-checkup history --report x.md`: the same two tables, for a wiki or a pull request. */
export function renderHistoryMarkdown(report: HistoryReport): string {
  const lines = [`# ${report.tool.name} history of \`${report.root}\``, '', `${report.points.length} points, one per month back from now. Generated ${report.generatedAt.slice(0, 10)} by ${report.tool.name} ${report.tool.version}.`, ''];
  lines.push('| Date | Commit | Angular | Score | Lines of code |', '| --- | --- | --- | ---: | ---: |');
  for (const point of report.points) lines.push(`| ${point.date} | \`${shortCommit(point)}\` | ${point.angularVersion ?? '-'} | ${point.score ?? '-'} | ${formatCount(point.linesOfCode)} |`);
  const moved = movedMeasures(report);
  if (moved.length > 0) {
    lines.push('', '## Moved most since the first point', '', '| Measure | First | Now | Change |', '| --- | ---: | ---: | ---: |');
    for (const entry of moved) lines.push(`| ${entry.label} | ${formatCount(entry.first)} | ${formatCount(entry.last)} | ${change(entry.first, entry.last)} |`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * `ng-checkup history --report x.html`: a self-contained page with the score
 * over time, one small chart per measure that moved most, and the table of
 * points. No script and no external request, like the checkup report.
 */
export function renderHistoryHtml(report: HistoryReport): string {
  const moved = movedMeasures(report);
  const rows = report.points
    .map((point) => `<tr><td>${escape(point.date)}</td><td><code>${escape(shortCommit(point))}</code></td><td>${escape(point.angularVersion ?? '-')}</td><td class="num">${point.score ?? '-'}</td><td class="num">${formatCount(point.linesOfCode)}</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>History of ${escape(report.root)}</title>
<style>${STYLES}${CHART_STYLES}h2 { margin: 36px 0 12px; font-size: 20px; }</style>
</head>
<body>
<main>
<header class="masthead"><div>
<p class="eyebrow">${escape(report.tool.name)} history</p>
<h1>${escape(report.root)}</h1>
<p class="meta">${report.points.length} points, one per month back from now. Generated ${escape(report.generatedAt.slice(0, 10))} by ${escape(report.tool.name)} ${escape(report.tool.version)}.</p>
</div></header>
<section class="charts">${historyCharts(report)}</section>
${moved.length === 0 ? '<p class="meta">No measure moved between the first point and now.</p>' : ''}
<h2>Points</h2>
<div class="table-wrap"><table class="projects"><thead><tr><th>Date</th><th>Commit</th><th>Angular</th><th class="num">Score</th><th class="num">Lines of code</th></tr></thead><tbody>${rows}</tbody></table></div>
</main>
</body>
</html>
`;
}
