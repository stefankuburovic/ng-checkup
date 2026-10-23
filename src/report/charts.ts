import { formatCount } from '../checks/context.js';
import type { HistoryPoint, HistoryReport } from '../history.js';
import { escape } from './escape.js';

/** `+3`, `-12`, `±0`: how a number moved, with its sign. */
export function change(first: number, last: number): string {
  const delta = last - first;
  return delta > 0 ? `+${formatCount(delta)}` : delta < 0 ? `-${formatCount(-delta)}` : '±0';
}

/**
 * The measures that moved the most between the first and the last point,
 * by absolute change, for the charts: a history of 40 measures where 35 sit
 * still reads better as the five that did not. A label recorded by two
 * checks appears once, under the first key.
 */
export function movedMeasures(report: HistoryReport, limit = 6): Array<{ key: string; label: string; first: number; last: number }> {
  const first = report.points[0];
  const last = report.points.at(-1);
  if (!first || !last) return [];
  return Object.keys(report.labels)
    .filter((key) => first.measures[key] !== undefined && last.measures[key] !== undefined)
    .map((key) => ({ key, label: report.labels[key]!, first: first.measures[key]!, last: last.measures[key]! }))
    .filter((entry) => entry.first !== entry.last)
    .sort((left, right) => Math.abs(right.last - right.first) - Math.abs(left.last - left.first) || left.key.localeCompare(right.key))
    // Two checks record legacy `*ngIf` under the same label; one chart of it is enough.
    .filter((entry, index, all) => all.findIndex((other) => other.label === entry.label) === index)
    .slice(0, limit);
}

/**
 * One line chart as inline SVG: a value per point, missing values leave a
 * gap. The y axis starts at zero (or spans 0 to 100 for the score), so a
 * drop from 412 to 398 looks like the small step it is rather than a cliff.
 * The x axis is time, not the point index: a month without a commit has no
 * point, and spacing the points evenly drew a five-month pause as one step.
 */
export function lineChart(points: HistoryPoint[], values: Array<number | undefined>, options: { title: string; max?: number; colour: string; width?: number; generatedAt?: string }): string {
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
  // "now" only when the last point is recent: the last commit of a repository untouched for two years is labelled with its month.
  const lastPoint = points.at(-1);
  const recent = lastPoint !== undefined && options.generatedAt !== undefined && Math.abs(Date.parse(options.generatedAt) - Date.parse(lastPoint.date)) <= 31 * 24 * 3600 * 1000;
  // Anchored at its end when the point sits at the right edge, where a centred "2023-03" would be cut off.
  if (lastPoint) tickLabels.push(`<text x="${lastX.toFixed(1)}" y="${height - 10}" text-anchor="${points.length > 1 ? 'end' : 'middle'}">${points.length > 1 && recent ? 'now' : escape(lastPoint.date.slice(0, 7))}</text>`);
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
export const CHART_STYLES = `
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin: 24px 0; }
.chart { margin: 0; padding: 14px 16px 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.chart.wide { grid-column: 1 / -1; }
.chart figcaption { font-weight: 600; font-size: 14px; margin-bottom: 6px; }
.chart svg { display: block; width: 100%; height: auto; }
.chart text { fill: var(--muted); font-size: 11px; font-family: inherit; }
.chart .grid { stroke: var(--border); stroke-width: 1; }
`;

/**
 * The charts of a history: the score over the full width, then one small
 * chart per measure that moved most, green when it fell (every measure
 * counts debt) and red when it grew. Used by the history page and by the
 * client report's "How the code got here" section.
 */
export function historyCharts(report: HistoryReport, limit = 6): string {
  const moved = movedMeasures(report, limit);
  return [
    lineChart(report.points, report.points.map((point) => point.score), { title: 'Score', max: 100, colour: 'var(--accent)', generatedAt: report.generatedAt }).replace('class="chart"', 'class="chart wide"'),
    ...moved.map((entry) =>
      lineChart(report.points, report.points.map((point) => point.measures[entry.key]), { title: `${entry.label} (${change(entry.first, entry.last)})`, colour: entry.last < entry.first ? 'var(--good)' : 'var(--poor)', width: 420, generatedAt: report.generatedAt }),
    ),
  ].join('\n');
}

/**
 * The client report's history section: one sentence on where the score and
 * Angular version started and where they are, then the charts. Empty for a
 * history of fewer than two points, which has nothing to show.
 */
export function historySection(report: HistoryReport | undefined): string {
  const first = report?.points[0];
  const last = report?.points.at(-1);
  if (!report || !first || !last || report.points.length < 2) return '';
  const months = Math.max(1, Math.round((Date.parse(last.date) - Date.parse(first.date)) / (30.44 * 24 * 3600 * 1000)));
  const scores = first.score !== undefined && last.score !== undefined ? (first.score === last.score ? `the score stayed at ${first.score}` : `the score went from ${first.score} to ${last.score}`) : undefined;
  const versions = first.angularVersion && last.angularVersion && first.angularVersion !== last.angularVersion ? `Angular from ${first.angularVersion} to ${last.angularVersion}` : undefined;
  const sentence = [scores, versions].filter(Boolean).join(', and ');
  return `<section aria-labelledby="history-title">
    <h2 id="history-title" class="section-title">How the code got here</h2>
    <p class="check-summary">${escape(`Over the last ${months === 1 ? 'month' : `${months} months`}${sentence ? `, ${sentence}` : ''}. One checkup per month from the git history; the charts show the score and the measures that moved most. Known vulnerabilities are left out of these scores, since only today's run looks them up, so the last point can differ from the score above.`)}</p>
    <div class="charts">${historyCharts(report)}</div>
  </section>`;
}
