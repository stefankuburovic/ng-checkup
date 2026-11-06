import { formatCount, plural } from '../checks/context.js';
import type { MeasureDelta } from '../baseline.js';
import type { DiffArea, DiffFinding, DiffReport, DiffSide } from '../diff.js';
import { escape } from './escape.js';
import { inline, STYLES } from './html.js';
import { scoreBand } from './summary.js';
import { palette } from './terminal.js';

const date = (side: DiffSide): string => side.generatedAt?.slice(0, 10) ?? '?';
const signed = (value: number): string => (value > 0 ? `+${formatCount(value)}` : formatCount(value));
const scoreChange = (report: DiffReport): string => {
  const { before, after } = report;
  if (before.score === undefined || after.score === undefined) return `${before.score ?? '-'} -> ${after.score ?? '-'}`;
  return `${before.score} -> ${after.score} (${signed(after.score - before.score)})`;
};
const movedAreas = (report: DiffReport): DiffArea[] => report.areas.filter((area) => area.change !== 'same');
/** Two areas can hold the same measure under one label (`*ngIf` uses in Components and in Deprecated APIs): one row is enough. The JSON keeps both. */
const distinct = (deltas: MeasureDelta[]): MeasureDelta[] => deltas.filter((delta, index) => deltas.findIndex((other) => other.label === delta.label && other.before === delta.before && other.after === delta.after) === index);
const measureLine = (delta: MeasureDelta): string => `${delta.label} (${formatCount(delta.before)} -> ${formatCount(delta.after)})`;
const heading = (report: DiffReport): string => (report.before.name === report.after.name ? report.after.name : `${report.before.name} and ${report.after.name}`);
const onlyLines = (report: DiffReport): string[] => [
  ...(report.measuresOnlyAfter.length > 0 ? [`${plural(report.measuresOnlyAfter.length, 'measure')} only in the "after" report, not counted as worse: ${report.measuresOnlyAfter.join(', ')}.`] : []),
  ...(report.measuresOnlyBefore.length > 0 ? [`${plural(report.measuresOnlyBefore.length, 'measure')} only in the "before" report, not counted as better: ${report.measuresOnlyBefore.join(', ')}.`] : []),
];

/** `ng-checkup diff` in a terminal. */
export function renderDiffTerminal(report: DiffReport, options: { color: boolean }): string {
  const c = palette(options.color);
  const { before, after } = report;
  const lines = [`${c.bold(report.tool.name)} ${c.dim(report.tool.version)}  ${c.bold('diff')} of ${heading(report)}`, ''];
  for (const note of report.notes) lines.push(`  ${c.yellow('note')} ${note}`);
  if (report.notes.length > 0) lines.push('');
  lines.push(`  ${c.dim('before')} ${date(before)}  Angular ${before.angularVersion ?? '-'}  ${formatCount(before.linesOfCode)} lines  ${c.dim(`ng-checkup ${before.toolVersion}`)}`);
  lines.push(`  ${c.dim('after ')} ${date(after)}  Angular ${after.angularVersion ?? '-'}  ${formatCount(after.linesOfCode)} lines  ${c.dim(`ng-checkup ${after.toolVersion}`)}`);
  lines.push('', `  ${c.bold('Score')} ${scoreChange(report)}`);

  const moved = movedAreas(report);
  if (moved.length > 0) {
    lines.push('', c.bold('Areas'));
    for (const area of moved) {
      const paint = area.change === 'better' ? c.green : area.change === 'worse' ? c.red : c.dim;
      lines.push(`  ${paint(`${area.before ?? '-'} -> ${area.after ?? '-'}`.padEnd(16))} ${area.title}`);
    }
  }
  const measures = (title: string, deltas: MeasureDelta[], paint: (text: string) => string): void => {
    if (deltas.length === 0) return;
    lines.push('', c.bold(title));
    for (const delta of distinct(deltas)) lines.push(`  ${paint(signed(delta.after - delta.before).padStart(7))}  ${measureLine(delta)}`);
  };
  measures('Worse', report.worsened, c.red);
  measures('Better', report.improved, c.green);
  const findings = (title: string, entries: DiffFinding[]): void => {
    if (entries.length === 0) return;
    lines.push('', c.bold(title));
    for (const finding of entries) lines.push(`  ${finding.severity.padEnd(6)} ${finding.message} ${c.dim(`(${finding.check})`)}`);
  };
  findings('New findings', report.newFindings);
  findings('Resolved findings', report.resolvedFindings);
  lines.push('', c.dim(`  ${plural(report.unchanged, 'measure')} unchanged.`));
  for (const line of onlyLines(report)) lines.push(c.dim(`  ${line}`));
  return lines.join('\n');
}

/** The comparison as Markdown, for a wiki page, an issue or a client mail. */
export function renderDiffMarkdown(report: DiffReport): string {
  const { before, after } = report;
  const lines = [`# ${heading(report)}: before and after`, '', `Generated ${report.generatedAt.slice(0, 10)} by ${report.tool.name} ${report.tool.version}.`, ''];
  for (const note of report.notes) lines.push(`> **Note:** ${note}`, '');
  lines.push('| | Before | After |', '| --- | --- | --- |');
  lines.push(`| Date | ${date(before)} | ${date(after)} |`, `| Score | ${before.score ?? '-'} | ${after.score ?? '-'} |`, `| Angular | ${before.angularVersion ?? '-'} | ${after.angularVersion ?? '-'} |`, `| Lines of code | ${formatCount(before.linesOfCode)} | ${formatCount(after.linesOfCode)} |`, `| ng-checkup | ${before.toolVersion} | ${after.toolVersion} |`);
  const moved = movedAreas(report);
  if (moved.length > 0) {
    lines.push('', '## Areas', '', '| Area | Before | After |', '| --- | --- | --- |');
    for (const area of moved) lines.push(`| ${area.title} | ${area.before ?? '-'} | ${area.after ?? '-'} |`);
  }
  const measures = (title: string, deltas: MeasureDelta[]): void => {
    if (deltas.length === 0) return;
    lines.push('', `## ${title}`, '', '| Measure | Before | After | Change |', '| --- | ---: | ---: | ---: |');
    for (const delta of distinct(deltas)) lines.push(`| ${delta.label} | ${formatCount(delta.before)} | ${formatCount(delta.after)} | ${signed(delta.after - delta.before)} |`);
  };
  measures('Worse', report.worsened);
  measures('Better', report.improved);
  const findings = (title: string, entries: DiffFinding[]): void => {
    if (entries.length === 0) return;
    lines.push('', `## ${title}`, '');
    for (const finding of entries) lines.push(`- **${finding.severity}** ${finding.message} (${finding.check})`);
  };
  findings('New findings', report.newFindings);
  findings('Resolved findings', report.resolvedFindings);
  lines.push('', `${plural(report.unchanged, 'measure')} unchanged.`);
  for (const line of onlyLines(report)) lines.push('', line);
  return `${lines.join('\n')}\n`;
}

/** The comparison as one self-contained HTML page, in the report's styles. */
export function renderDiffHtml(report: DiffReport): string {
  const { before, after } = report;
  const pill = (grade: string | undefined): string => `<span class="pill grade-${grade ?? 'info'}">${grade ?? '-'}</span>`;
  const score = (value: number | undefined): string => `<span class="pill grade-${scoreBand(value)}">${value ?? '-'}</span>`;
  const table = (head: string, rows: string): string => `<div class="table-wrap"><table class="projects"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const moved = movedAreas(report);
  const measures = (title: string, deltas: MeasureDelta[]): string =>
    deltas.length === 0
      ? ''
      : `<h2>${title}</h2>${table('<th>Measure</th><th class="num">Before</th><th class="num">After</th><th class="num">Change</th>', distinct(deltas).map((delta) => `<tr><td>${escape(delta.label)}</td><td class="num">${formatCount(delta.before)}</td><td class="num">${formatCount(delta.after)}</td><td class="num">${signed(delta.after - delta.before)}</td></tr>`).join(''))}`;
  const findings = (title: string, entries: DiffFinding[]): string =>
    entries.length === 0
      ? ''
      : `<h2>${title}</h2>${table('<th>Severity</th><th>Finding</th><th>Area</th>', entries.map((finding) => `<tr><td>${escape(finding.severity)}</td><td>${inline(finding.message)}</td><td>${escape(finding.check)}</td></tr>`).join(''))}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(heading(report))}: before and after</title>
<style>${STYLES}h2 { margin: 36px 0 12px; font-size: 20px; }</style>
</head>
<body>
<main>
<header class="masthead"><div>
<p class="eyebrow">${escape(report.tool.name)} diff</p>
<h1>${escape(heading(report))}: score ${escape(scoreChange(report).replace('->', '→'))}</h1>
<p class="meta">Generated ${escape(report.generatedAt.slice(0, 10))} by ${escape(report.tool.name)} ${escape(report.tool.version)}.</p>
</div></header>
${report.notes.map((note) => `<p><strong>Note:</strong> ${inline(note)}</p>`).join('\n')}
${table('<th></th><th>Before</th><th>After</th>', [
  `<tr><td>Date</td><td>${escape(date(before))}</td><td>${escape(date(after))}</td></tr>`,
  `<tr><td>Score</td><td>${score(before.score)}</td><td>${score(after.score)}</td></tr>`,
  `<tr><td>Angular</td><td>${escape(before.angularVersion ?? '-')}</td><td>${escape(after.angularVersion ?? '-')}</td></tr>`,
  `<tr><td>Lines of code</td><td>${formatCount(before.linesOfCode)}</td><td>${formatCount(after.linesOfCode)}</td></tr>`,
  `<tr><td>ng-checkup</td><td>${escape(before.toolVersion)}</td><td>${escape(after.toolVersion)}</td></tr>`,
].join(''))}
${moved.length === 0 ? '' : `<h2>Areas</h2>${table('<th>Area</th><th>Before</th><th>After</th>', moved.map((area) => `<tr><td>${escape(area.title)}</td><td>${pill(area.before)}</td><td>${pill(area.after)}</td></tr>`).join(''))}`}
${measures('Worse', report.worsened)}
${measures('Better', report.improved)}
${findings('New findings', report.newFindings)}
${findings('Resolved findings', report.resolvedFindings)}
<p class="meta">${escape(plural(report.unchanged, 'measure'))} unchanged.</p>
${onlyLines(report).map((line) => `<p class="meta">${escape(line)}</p>`).join('\n')}
</main>
</body>
</html>
`;
}

/** The comparison in the format a file extension names: `.html`, `.md` or `.json`. */
export function renderDiffForFile(report: DiffReport, path: string): string {
  if (path.endsWith('.json')) return `${JSON.stringify(report, null, 2)}\n`;
  if (path.endsWith('.md')) return renderDiffMarkdown(report);
  return renderDiffHtml(report);
}
