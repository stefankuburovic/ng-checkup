import { trendSentence } from '../trend.js';
import { formatCount, plural } from '../checks/context.js';
import type { Grade, Report, Severity } from '../types.js';
import { formatDuration, formatLocation, gradeLabel, kindLabel, migrationTarget, overallScore, projectAreas, remainingCount, SCORE_EXPLANATION, severityLabel, topPriorities } from './summary.js';

/** Options for the terminal renderer. */
export interface TerminalOptions {
  /** ANSI colours. The CLI turns them off for a non-TTY, `NO_COLOR` or `--no-color`. */
  color: boolean;
  /** Every finding of every check instead of the summary and the top priorities. */
  verbose: boolean;
}

/** A tiny ANSI palette; every function is the identity when colour is off. */
/** ANSI styles, or identity functions when `enabled` is false. */
export function palette(enabled: boolean) {
  const wrap = (open: number, close: number) => (text: string) => (enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text);
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39), gray: wrap(90, 39) };
}

/**
 * Renders the report for a terminal.
 *
 * By default it shows one line per check and the top priorities, which fits a
 * screen and is what someone running the tool for the first time wants;
 * `verbose` adds every finding with its example files, and keeps the top
 * priorities at the end. The file reports
 * (`--report x.html`) always carry everything, so the terminal never has to.
 */
export function renderTerminal(report: Report, options: TerminalOptions): string {
  const c = palette(options.color);
  /** Backtick spans become cyan text without the backticks; without colour the backticks stay as the only marker. */
  const code = (text: string): string => (options.color ? text.replace(/`([^`]+)`/g, (_, inner: string) => c.cyan(inner)) : text);
  const gradeBadge = (grade: Grade): string => {
    const label = ` ${gradeLabel(grade).toUpperCase().padEnd(4)} `;
    return { good: c.green, fair: c.yellow, poor: c.red, info: c.gray }[grade](options.color ? c.bold(label) : `[${gradeLabel(grade).toUpperCase()}]`.padEnd(7));
  };
  const severityTag = (severity: Severity): string => ({ high: c.red, medium: c.yellow, low: c.gray, info: c.gray })[severity](severityLabel(severity).toLowerCase().padEnd(6));

  const lines: string[] = [];
  const { project } = report;
  lines.push(`${c.bold(report.tool.name)} ${c.dim(report.tool.version)}  ${c.bold(project.name)} ${c.dim(`· ${kindLabel(report)}${project.workspaceFolder ? ` in ${project.workspaceFolder}` : ''}${project.angularVersion ? ` · Angular ${project.angularVersion}` : ''}`)}`);
  lines.push(c.dim(`${`${plural(project.sourceFiles, 'TypeScript file')}${project.javascriptFiles ? `, ${plural(project.javascriptFiles, 'JavaScript file')}` : ''}`}, ${plural(project.templateFiles, 'template')}, ${plural(project.linesOfCode, 'line')} of application code${project.generatedFiles ? ` (${plural(project.generatedFiles, 'generated file')} left out)` : ''}, analysed in ${formatDuration(report.durationMs)}`));
  const trend = report.trend ? trendSentence(report.trend) : undefined;
  if (trend) lines.push(c.dim(`Last ${report.trend!.days} days: ${trend}`));
  lines.push('');

  const titleWidth = Math.max(...report.checks.map((check) => check.title.length));
  for (const check of report.checks) {
    lines.push(`${gradeBadge(check.grade)} ${c.bold(check.title.padEnd(titleWidth))}  ${code(check.summary)}`);
    if (!options.verbose) continue;
    for (const finding of check.findings) {
      lines.push(`         ${severityTag(finding.severity)} ${code(finding.message)}`);
      if (finding.detail) lines.push(`                ${c.dim(code(finding.detail))}`);
      for (const file of finding.files ?? []) lines.push(`                ${c.gray(formatLocation(file))}`);
      const more = remainingCount(finding);
      if (more > 0) lines.push(`                ${c.gray(`and ${formatCount(more)} more`)}`);
    }
  }

  const score = overallScore(report);
  if (score !== undefined) {
    lines.push('');
    const color = score >= 80 ? c.green : score >= 50 ? c.yellow : c.red;
    lines.push(`${c.bold('Score')} ${color(c.bold(`${score}/100`))}  ${c.dim(SCORE_EXPLANATION)}`);
  }

  // Ten rows are enough to see where the work is; a 200-project monorepo
  // would otherwise push everything else off the screen.
  const projects = report.projects ?? [];
  if (projects.length > 0) {
    const shown = options.verbose ? projects : projects.slice(0, 10);
    const nameWidth = Math.max(...shown.map((row) => row.name.length));
    const rootWidth = Math.max(...shown.map((row) => (row.root || '.').length));
    lines.push('');
    lines.push(`${c.bold('Projects')}  ${c.dim(`${projects.length}, worst first, graded on their own code`)}`);
    for (const row of shown) {
      const { poor, fair } = projectAreas(row, report);
      const scoreText = row.score === undefined ? '  -' : String(row.score).padStart(3);
      const color = row.score === undefined ? c.gray : row.score >= 80 ? c.green : row.score >= 50 ? c.yellow : c.red;
      const areas = [poor.length > 0 ? c.red(`poor: ${poor.join(', ')}`) : '', fair.length > 0 ? c.yellow(`fair: ${fair.join(', ')}`) : ''].filter(Boolean).join('  ');
      lines.push(`  ${color(scoreText)}  ${row.name.padEnd(nameWidth)}  ${c.dim((row.root || '.').padEnd(rootWidth))}  ${areas}`.trimEnd());
    }
    if (shown.length < projects.length) lines.push(c.dim(`  and ${projects.length - shown.length} more: --verbose, or the HTML or Markdown report`));
  }

  const comparison = report.baseline;
  if (comparison) {
    lines.push('');
    const { regressions, improvements } = comparison;
    if (regressions.length === 0 && improvements.length === 0) {
      lines.push(`${c.bold('Baseline')}  ${c.dim('no change')}`);
    } else {
      const parts = [regressions.length > 0 ? c.red(`${regressions.length} worse`) : undefined, improvements.length > 0 ? c.green(`${improvements.length} better`) : undefined].filter(Boolean);
      lines.push(`${c.bold('Baseline')}  ${parts.join(', ')}`);
      for (const delta of regressions) lines.push(`  ${c.red('worse ')} ${delta.check}: ${delta.label} ${delta.before} → ${c.bold(String(delta.after))}`);
      const shown = options.verbose ? improvements : improvements.slice(0, 5);
      for (const delta of shown) lines.push(`  ${c.green('better')} ${delta.check}: ${delta.label} ${delta.before} → ${delta.after}`);
      if (shown.length < improvements.length) lines.push(c.dim(`  and ${improvements.length - shown.length} more better`));
      if (improvements.length > 0 && regressions.length === 0) lines.push(c.dim('  Lock the improvements in with: ng-checkup baseline'));
    }
  }

  const migration = report.migration;
  if (migration) {
    lines.push('');
    lines.push(`${c.bold('Migration plan')}  ${migration.from} → ${migrationTarget(migration)}, ${plural(migration.phases.length, 'phase')}`);
    migration.phases.forEach((phase, index) => {
      lines.push(`  ${c.bold(`${index + 1}. ${phase.title}`)}  ${c.dim(phase.goal)}`);
      for (const item of phase.items) lines.push(`        · ${code(item.title)}${item.count !== undefined ? c.dim(` (${formatCount(item.count)})`) : ''}${item.command ? `  ${c.cyan(item.command)}` : ''}`);
    });
  }

  const plan = report.plan;
  if (plan) {
    lines.push('');
    lines.push(`${c.bold('Upgrade plan')}  ${plan.from} → ${plan.to}, ${plural(plan.steps.length, 'step')}, one major at a time`);
    if (plan.before.length > 0) {
      lines.push(`  ${c.bold('Before you start')}`);
      for (const item of plan.before) lines.push(`    · ${code(item.title)}${item.count !== undefined ? c.dim(` (${formatCount(item.count)})`) : ''}${item.command ? `  ${c.cyan(item.command)}` : ''}`);
    }
    for (const step of plan.steps) {
      lines.push(`  ${c.bold(`→ ${step.to}`)}  ${c.cyan(step.command)}`);
      const notes = step.requirements.filter((requirement) => requirement.name === 'Node.js' || requirement.satisfied === false || requirement.current === undefined);
      const shown = notes.map((requirement) => `${requirement.name} ${requirement.range}${requirement.satisfied === false ? c.yellow(` (now ${requirement.current})`) : ''}`);
      if (shown.length > 0) lines.push(`        ${c.dim(shown.join(' · '))}`);
      for (const item of step.items) lines.push(`        · ${code(item.title)}${item.count !== undefined ? c.dim(` (${formatCount(item.count)})`) : ''}${item.command ? `  ${c.cyan(item.command)}` : ''}`);
    }
  }

  // Shown with --verbose too: the full list above says what there is, this says where to start.
  const priorities = topPriorities(report);
  if (priorities.length > 0) {
    lines.push('');
    lines.push(c.bold('Top priorities'));
    priorities.forEach(({ check, finding }, index) => {
      lines.push(`  ${index + 1}. ${severityTag(finding.severity)} ${code(finding.message)} ${c.dim(`(${check.title})`)}`);
      const [first] = finding.files ?? [];
      const total = finding.count ?? finding.files?.length ?? 0;
      if (first) lines.push(`              ${c.gray(`${formatLocation(first)}${total > 1 ? ` and ${formatCount(total - 1)} more` : ''}`)}`);
    });
  }

  if (!options.verbose) {
    lines.push('');
    lines.push(c.dim('Every finding with its files: --verbose, or write a report with --report checkup.html (also .md, .json).'));
  }
  return lines.join('\n');
}
