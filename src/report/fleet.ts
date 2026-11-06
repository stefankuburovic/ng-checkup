import { formatCount } from '../checks/context.js';
import type { FleetReport, FleetRow } from '../fleet.js';
import type { Grade } from '../types.js';
import { escape } from './escape.js';
import { STYLES } from './html.js';
import { scoreBand } from './summary.js';
import { palette } from './terminal.js';

/** The areas a row is poor or fair in, by title, worst first. */
function weakAreas(report: FleetReport, row: FleetRow): { poor: string[]; fair: string[] } {
  const titled = (grade: Grade): string[] => report.areas.filter((area) => row.grades[area.id] === grade).map((area) => area.title);
  return { poor: titled('poor'), fair: titled('fair') };
}

/** `ng-checkup fleet` in a terminal: one line per repository, worst first, with its poor areas. */
export function renderFleetTerminal(report: FleetReport, options: { color: boolean }): string {
  const c = palette(options.color);
  const width = Math.max(10, ...report.rows.map((row) => row.name.length));
  const lines = [`${c.bold(report.tool.name)} ${c.dim(report.tool.version)}  ${c.bold('fleet')} ${c.dim(`of ${report.rows.length} repositories, worst first`)}`, ''];
  lines.push(c.dim(`  ${'repository'.padEnd(width)} ${'Angular'.padEnd(9)} ${'score'.padStart(5)} ${'high'.padStart(4)}  poor areas`));
  for (const row of report.rows) {
    if (row.error) {
      lines.push(`  ${row.name.padEnd(width)} ${c.dim(`not checked: ${row.error}`)}`);
      continue;
    }
    const { poor } = weakAreas(report, row);
    lines.push(`  ${row.name.padEnd(width)} ${(row.angularVersion ?? '-').padEnd(9)} ${c.bold(String(row.score ?? '-').padStart(5))} ${String(row.highFindings).padStart(4)}  ${poor.join(', ') || c.dim('none')}`);
  }
  return lines.join('\n');
}

/** The fleet as a Markdown table, for a wiki page or an issue. */
export function renderFleetMarkdown(report: FleetReport): string {
  const lines = [`# Angular fleet: ${report.rows.length} repositories`, '', `Worst first. Generated ${report.generatedAt.slice(0, 10)} by ${report.tool.name} ${report.tool.version}.`, ''];
  lines.push('| Repository | Angular | Score | High | Poor | Fair |', '| --- | --- | ---: | ---: | --- | --- |');
  for (const row of report.rows) {
    if (row.error) {
      lines.push(`| ${row.name} | | | | not checked: ${row.error.replace(/\|/g, '\\|')} | |`);
      continue;
    }
    const { poor, fair } = weakAreas(report, row);
    lines.push(`| **${row.name}**${row.commit ? ` \`${row.commit}\`` : ''} | ${row.angularVersion ?? '-'} | ${row.score ?? '-'} | ${row.highFindings} | ${poor.join(', ')} | ${fair.join(', ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

/** The fleet as one self-contained HTML page: a ranked table with a pill per area, in the report's styles. */
export function renderFleetHtml(report: FleetReport): string {
  const checked = report.rows.filter((row) => !row.error);
  const scored = checked.filter((row) => row.score !== undefined);
  const average = scored.length === 0 ? undefined : Math.round(scored.reduce((sum, row) => sum + row.score!, 0) / scored.length);
  const header = report.areas.map((area) => `<th title="${escape(area.title)}">${escape(area.title)}</th>`).join('');
  const rows = report.rows
    .map((row) => {
      if (row.error) return `<tr><td><strong>${escape(row.name)}</strong></td><td colspan="${4 + report.areas.length}" class="meta">not checked: ${escape(row.error)}</td></tr>`;
      const cells = report.areas.map((area) => {
        const grade = row.grades[area.id] ?? 'info';
        return `<td><span class="pill grade-${grade}">${grade === 'info' ? '-' : grade}</span></td>`;
      });
      return `<tr><td><strong>${escape(row.name)}</strong><br><code>${escape(row.entry)}${row.commit ? ` @ ${escape(row.commit)}` : ''}</code></td><td>${escape(row.angularVersion ?? '-')}</td><td class="num"><span class="pill grade-${scoreBand(row.score)}">${row.score ?? '-'}</span></td><td class="num">${row.highFindings}</td><td class="num">${formatCount(row.linesOfCode)}</td>${cells.join('')}</tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Angular fleet: ${report.rows.length} repositories</title>
<style>${STYLES}table.projects th { white-space: nowrap; } table.projects td { vertical-align: top; }</style>
</head>
<body>
<main>
<header class="masthead"><div>
<p class="eyebrow">${escape(report.tool.name)} fleet</p>
<h1>${report.rows.length} repositories${average === undefined ? '' : `, average score ${average}`}</h1>
<p class="meta">Worst first. ${checked.length < report.rows.length ? `${report.rows.length - checked.length} could not be checked. ` : ''}Generated ${escape(report.generatedAt.slice(0, 10))} by ${escape(report.tool.name)} ${escape(report.tool.version)}.</p>
</div></header>
<div class="table-wrap"><table class="projects"><thead><tr><th>Repository</th><th>Angular</th><th class="num">Score</th><th class="num">High</th><th class="num">Lines</th>${header}</tr></thead><tbody>
${rows}
</tbody></table></div>
</main>
</body>
</html>
`;
}

/** The fleet in the format a file extension names: `.html`, `.md` or `.json`. */
export function renderFleetForFile(report: FleetReport, path: string): string {
  if (path.endsWith('.json')) return `${JSON.stringify(report, null, 2)}\n`;
  if (path.endsWith('.md')) return renderFleetMarkdown(report);
  return renderFleetHtml(report);
}
