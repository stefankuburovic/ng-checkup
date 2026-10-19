import { formatCount, plural } from '../checks/context.js';
import type { Report } from '../types.js';
import { formatDuration, formatLocation, gradeLabel, kindLabel, overallScore, remainingCount, SCORE_EXPLANATION, severityLabel, topPriorities } from './summary.js';

/**
 * Renders the report as GitHub-flavoured Markdown, for a pull request, a
 * wiki page or an issue. Finding text already uses Markdown backticks, so it
 * goes in as written; only table cells are escaped, where a `|` would split
 * the row.
 */
export function renderMarkdown(report: Report): string {
  const { project } = report;
  const lines: string[] = [];
  const score = overallScore(report);

  lines.push(`# Angular checkup: ${project.name}`, '');
  lines.push(
    `${kindLabel(project.kind)}${project.angularVersion ? ` · Angular ${project.angularVersion}` : ''} · ${plural(project.sourceFiles, 'TypeScript file')} · ${plural(project.templateFiles, 'template')} · ${plural(project.linesOfCode, 'line')} of application code`,
    '',
  );
  if (score !== undefined) lines.push(`**Score: ${score}/100.** ${SCORE_EXPLANATION}`, '');

  lines.push('| Area | Grade | Summary |', '| --- | --- | --- |');
  for (const check of report.checks) lines.push(`| ${cell(check.title)} | ${gradeLabel(check.grade)} | ${cell(check.summary)} |`);
  lines.push('');

  const priorities = topPriorities(report);
  if (priorities.length > 0) {
    lines.push('## Top priorities', '');
    priorities.forEach(({ check, finding }, index) => lines.push(`${index + 1}. **${severityLabel(finding.severity)}:** ${finding.message} _(${check.title})_`));
    lines.push('');
  }

  for (const check of report.checks) {
    lines.push(`## ${check.title}: ${gradeLabel(check.grade)}`, '', check.summary, '');
    if (check.metrics.length > 0) {
      lines.push('| Metric | Value | |', '| --- | --- | --- |');
      for (const metric of check.metrics) lines.push(`| ${cell(metric.label)} | ${cell(String(metric.value))} | ${cell(metric.hint ?? '')} |`);
      lines.push('');
    }
    for (const finding of check.findings) {
      lines.push(`- **${severityLabel(finding.severity)}:** ${finding.message}`);
      if (finding.detail) lines.push(`  ${finding.detail}`);
      for (const file of finding.files ?? []) lines.push(`  - \`${formatLocation(file)}\``);
      const more = remainingCount(finding);
      if (more > 0) lines.push(`  - and ${formatCount(more)} more`);
    }
    if (check.findings.length > 0) lines.push('');
  }

  lines.push('---', '', `Generated ${report.generatedAt.slice(0, 10)} by ${report.tool.name} ${report.tool.version} in ${formatDuration(report.durationMs)}.`, '');
  return lines.join('\n');
}

/** Escapes a table cell: a `|` would end it and a newline would end the row. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
