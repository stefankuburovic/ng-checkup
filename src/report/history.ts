import { formatCount } from '../checks/context.js';
import { movedMeasures, type HistoryPoint, type HistoryReport } from '../history.js';
import { escape, STYLES } from './html.js';
import { palette } from './terminal.js';

/** A point's commit as the reports show it: seven characters, or `working tree`. */
function shortCommit(point: HistoryPoint): string {
  return point.commit === 'working tree' ? 'now' : point.commit.slice(0, 7);
}

/** `+3`, `-12`, `±0`: how a number moved, with its sign. */
function change(first: number, last: number): string {
  const delta = last - first;
  return delta > 0 ? `+${formatCount(delta)}` : delta < 0 ? `-${formatCount(-delta)}` : '±0';
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
 * One line chart as inline SVG: a value per point, missing values leave a
 * gap. The y axis starts at zero (or spans 0 to 100 for the score), so a
 * drop from 412 to 398 looks like the small step it is rather than a cliff.
 * The x axis is time, not the point index: a month without a commit has no
 * point, and spacing the points evenly drew a five-month pause as one step.
 */
function lineChart(points: HistoryPoint[], values: Array<number | undefined>, options: { title: string; max?: number; colour: string; width?: number }): string {
  // The small charts sit two to a row, so a narrower viewBox keeps their text at the same size as the wide one's.
  const width = options.width ?? 640;
  const height = 170;
  const left = 44;
  const right = 16;
  const top = 14;
  const bottom = 30;
  const known = values.filter((value): value is number => value !== undefined);
  const max = options.max ?? roundUp(Math.max(1, ...known));
  const times = points.map((point) => Date.parse(point.date));
  const first = times[0] ?? 0;
  const span = (times.at(-1) ?? first) - first;
  const xAt = (time: number): number => (span === 0 ? left + (width - left - right) / 2 : left + ((time - first) * (width - left - right)) / span);
  const x = (index: number): number => xAt(times[index] ?? first);
  const y = (value: number): number => top + (height - top - bottom) * (1 - value / max);
  const segments: string[][] = [[]];
  values.forEach((value, index) => {
    if (value === undefined) segments.push([]);
    else segments.at(-1)!.push(`${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  });
  const lines = segments.filter((segment) => segment.length > 1).map((segment) => `<polyline points="${segment.join(' ')}" fill="none" stroke="${options.colour}" stroke-width="2" stroke-linejoin="round"/>`);
  const dots = values.map((value, index) => (value === undefined ? '' : `<circle cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="3" fill="${options.colour}"><title>${escape(`${points[index]!.date}: ${formatCount(value)}`)}</title></circle>`));
  const labels = timeTicks(first, first + span).map((tick) => ({ ...tick, x: xAt(tick.time) }));
  // "now" marks the last point; a tick closer to it than 60 units would print over it.
  const lastX = x(points.length - 1);
  const tickLabels = labels.filter((tick) => lastX - tick.x >= 60).map((tick) => `<text x="${tick.x.toFixed(1)}" y="${height - 10}" text-anchor="middle">${escape(tick.label)}</text>`);
  if (points.length > 0) tickLabels.push(`<text x="${lastX.toFixed(1)}" y="${height - 10}" text-anchor="middle">${points.length === 1 ? escape(points[0]!.date.slice(0, 7)) : 'now'}</text>`);
  // Half of an odd maximum (15) is 7.5; rounding it to 8 would put the label off its line.
  const grid = [0, max / 2, max].map((value) => `<line x1="${left}" x2="${width - right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}" class="grid"/><text x="${left - 8}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end">${Number.isInteger(value) ? formatCount(value) : value.toFixed(1)}</text>`);
  return `<figure class="chart"><figcaption>${escape(options.title)}</figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(options.title)}">${grid.join('')}${lines.join('')}${dots.join('')}${tickLabels.join('')}</svg></figure>`;
}

/**
 * Labels for the time axis: the first of every `step` months between `from`
 * and `to` (epoch milliseconds), the step chosen so there are at most five,
 * as `2024` when the step is a year and `2024-07` otherwise. A history of
 * three years reads by year, one of six months by month.
 */
function timeTicks(from: number, to: number): Array<{ time: number; label: string }> {
  const start = new Date(from);
  const months = (new Date(to).getUTCFullYear() - start.getUTCFullYear()) * 12 + new Date(to).getUTCMonth() - start.getUTCMonth();
  const step = [1, 2, 3, 6, 12, 24].find((candidate) => months / candidate <= 5) ?? 24;
  const ticks: Array<{ time: number; label: string }> = [];
  for (let year = start.getUTCFullYear(), month = start.getUTCMonth() + 1; ; month++) {
    if (month === 12) {
      year++;
      month = 0;
    }
    const time = Date.UTC(year, month, 1);
    if (time > to) break;
    // Aligned to the calendar: every January for a yearly step, every January and July for a half-yearly one.
    if ((year * 12 + month) % step === 0) ticks.push({ time, label: step % 12 === 0 ? String(year) : `${year}-${String(month + 1).padStart(2, '0')}` });
  }
  return ticks;
}

/** The next round number (1, 1.5, 2, 3, 4, 5, 6 or 8 times a power of ten) at or above `value`, so an axis ends on 3 000 rather than 2 896. */
function roundUp(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 1.5, 2, 3, 4, 5, 6, 8, 10].map((step) => step * power).find((candidate) => candidate >= value) ?? 10 * power);
}

/** Rules for the charts, on top of the report stylesheet. */
const HISTORY_STYLES = `
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin: 24px 0; }
.chart { margin: 0; padding: 14px 16px 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.chart.wide { grid-column: 1 / -1; }
.chart figcaption { font-weight: 600; font-size: 14px; margin-bottom: 6px; }
.chart svg { display: block; width: 100%; height: auto; }
.chart text { fill: var(--muted); font-size: 11px; font-family: inherit; }
.chart .grid { stroke: var(--border); stroke-width: 1; }
h2 { margin: 36px 0 12px; font-size: 20px; }
`;

/**
 * `ng-checkup history --report x.html`: a self-contained page with the score
 * over time, one small chart per measure that moved most, and the table of
 * points. No script and no external request, like the checkup report.
 */
export function renderHistoryHtml(report: HistoryReport): string {
  const moved = movedMeasures(report);
  const charts = [
    lineChart(report.points, report.points.map((point) => point.score), { title: 'Score', max: 100, colour: 'var(--accent)' }).replace('class="chart"', 'class="chart wide"'),
    ...moved.map((entry) => lineChart(report.points, report.points.map((point) => point.measures[entry.key]), { title: `${entry.label} (${change(entry.first, entry.last)})`, colour: entry.last < entry.first ? 'var(--good)' : 'var(--poor)', width: 420 })),
  ];
  const rows = report.points
    .map((point) => `<tr><td>${escape(point.date)}</td><td><code>${escape(shortCommit(point))}</code></td><td>${escape(point.angularVersion ?? '-')}</td><td class="num">${point.score ?? '-'}</td><td class="num">${formatCount(point.linesOfCode)}</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>History of ${escape(report.root)}</title>
<style>${STYLES}${HISTORY_STYLES}</style>
</head>
<body>
<main>
<header class="masthead"><div>
<p class="eyebrow">${escape(report.tool.name)} history</p>
<h1>${escape(report.root)}</h1>
<p class="meta">${report.points.length} points, one per month back from now. Generated ${escape(report.generatedAt.slice(0, 10))} by ${escape(report.tool.name)} ${escape(report.tool.version)}.</p>
</div></header>
<section class="charts">${charts.join('\n')}</section>
${moved.length === 0 ? '<p class="meta">No measure moved between the first point and now.</p>' : ''}
<h2>Points</h2>
<div class="table-wrap"><table class="projects"><thead><tr><th>Date</th><th>Commit</th><th>Angular</th><th class="num">Score</th><th class="num">Lines of code</th></tr></thead><tbody>${rows}</tbody></table></div>
</main>
</body>
</html>
`;
}
