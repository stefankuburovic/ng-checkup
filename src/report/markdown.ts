import { formatCount, plural } from '../checks/context.js';
import type { Report } from '../types.js';
import { formatDuration, formatLocation, gradeLabel, kindLabel, migrationTarget, overallScore, projectAreas, remainingCount, SCORE_EXPLANATION, severityLabel, topPriorities } from './summary.js';

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
    `${kindLabel(project.kind)}${project.angularVersion ? ` · Angular ${project.angularVersion}` : ''} · ${`${plural(project.sourceFiles, 'TypeScript file')}${project.javascriptFiles ? `, ${plural(project.javascriptFiles, 'JavaScript file')}` : ''}`} · ${plural(project.templateFiles, 'template')} · ${plural(project.linesOfCode, 'line')} of application code${project.generatedFiles ? ` (${plural(project.generatedFiles, 'generated file')} left out)` : ''}`,
    '',
  );
  if (score !== undefined) lines.push(`**Score: ${score}/100.** ${SCORE_EXPLANATION}`, '');

  lines.push('| Area | Grade | Summary |', '| --- | --- | --- |');
  for (const check of report.checks) lines.push(`| ${cell(check.title)} | ${gradeLabel(check.grade)} | ${cell(check.summary)} |`);
  lines.push('');

  const projects = report.projects ?? [];
  if (projects.length > 0) {
    lines.push('## Projects', '', `${plural(projects.length, 'project')}, worst first. Each is graded on its own code; the Angular version and the third-party packages are shared and graded above.`, '');
    lines.push('| Project | Type | Score | Files | High findings | Poor | Fair |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of projects) {
      const { poor, fair } = projectAreas(row, report);
      lines.push(`| ${cell(row.name)} \`${cell(row.root || '.')}\` | ${row.type} | ${row.score ?? '-'} | ${formatCount(row.sourceFiles)} | ${row.highFindings} | ${cell(poor.join(', '))} | ${cell(fair.join(', '))} |`);
    }
    lines.push('');
  }

  const priorities = topPriorities(report);
  if (priorities.length > 0) {
    lines.push('## Top priorities', '');
    priorities.forEach(({ check, finding }, index) => lines.push(`${index + 1}. **${severityLabel(finding.severity)}:** ${finding.message} _(${check.title})_`));
    lines.push('');
  }

  const migration = report.migration;
  if (migration) {
    lines.push(`## Migration plan: ${migration.from} → ${migrationTarget(migration)}`, '', `${plural(migration.phases.length, 'phase')}, each shipping on its own.`, '');
    migration.phases.forEach((phase, index) => {
      lines.push(`### ${index + 1}. ${phase.title}`, '', `_${phase.goal}_`, '');
      for (const item of phase.items) lines.push(`- **${item.title}**${item.count !== undefined ? ` (${formatCount(item.count)})` : ''}${item.command ? `: \`${item.command}\`` : ''}${item.detail ? `. ${item.detail}` : ''}`);
      lines.push('');
    });
  }

  const plan = report.plan;
  if (plan) {
    lines.push(`## Upgrade plan: Angular ${plan.from} → ${plan.to}`, '', `${plural(plan.steps.length, 'step')}, one major at a time, as \`ng update\` requires.`, '');
    if (plan.before.length > 0) {
      lines.push('**Before you start**', '');
      for (const item of plan.before) lines.push(`- ${item.title}${item.count !== undefined ? ` (${formatCount(item.count)})` : ''}${item.command ? `: \`${item.command}\`` : ''}${item.detail ? `. ${item.detail}` : ''}`);
      lines.push('');
    }
    for (const step of plan.steps) {
      lines.push(`### → ${step.to} (${step.version})`, '', '```bash', step.command, '```', '');
      lines.push(step.requirements.map((requirement) => `${requirement.name} \`${requirement.range}\`${requirement.satisfied === false ? ` (now ${requirement.current}, move it in this step)` : ''}`).join(' · '), '');
      for (const item of step.items) lines.push(`- **${item.title}**${item.count !== undefined ? ` (${formatCount(item.count)})` : ''}${item.command ? `: \`${item.command}\`` : ''}${item.detail ? `. ${item.detail}` : ''}`);
      if (step.items.length > 0) lines.push('');
    }
  }

  const comparison = report.baseline;
  if (comparison && (comparison.regressions.length > 0 || comparison.improvements.length > 0)) {
    lines.push('## Compared with the baseline', '');
    lines.push(`${comparison.regressions.length} worse, ${comparison.improvements.length} better.`, '');
    lines.push('| | Area | Measure | Baseline | Now |', '| --- | --- | --- | --- | --- |');
    for (const delta of comparison.regressions) lines.push(`| Worse | ${cell(delta.check)} | ${cell(delta.label)} | ${delta.before} | **${delta.after}** |`);
    for (const delta of comparison.improvements) lines.push(`| Better | ${cell(delta.check)} | ${cell(delta.label)} | ${delta.before} | ${delta.after} |`);
    lines.push('');
  } else if (comparison) {
    lines.push('## Compared with the baseline', '', 'No change.', '');
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
