import { formatCount, plural } from '../checks/context.js';
import type { Grade, Report, Severity } from '../types.js';
import { formatDuration, formatLocation, gradeLabel, kindLabel, overallScore, remainingCount, SCORE_EXPLANATION, severityLabel, topPriorities } from './summary.js';

/** Options for the terminal renderer. */
export interface TerminalOptions {
  /** ANSI colours. The CLI turns them off for a non-TTY, `NO_COLOR` or `--no-color`. */
  color: boolean;
  /** Every finding of every check instead of the summary and the top priorities. */
  verbose: boolean;
}

/** A tiny ANSI palette; every function is the identity when colour is off. */
function palette(enabled: boolean) {
  const wrap = (open: number, close: number) => (text: string) => (enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text);
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39), gray: wrap(90, 39) };
}

/**
 * Renders the report for a terminal.
 *
 * By default it shows one line per check and the top priorities, which fits a
 * screen and is what someone running the tool for the first time wants;
 * `verbose` adds every finding with its example files. The file reports
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
  lines.push(`${c.bold(report.tool.name)} ${c.dim(report.tool.version)}  ${c.bold(project.name)} ${c.dim(`· ${kindLabel(project.kind)}${project.angularVersion ? ` · Angular ${project.angularVersion}` : ''}`)}`);
  lines.push(c.dim(`${plural(project.sourceFiles, 'TypeScript file')}, ${plural(project.templateFiles, 'template')}, ${plural(project.linesOfCode, 'line')} of application code, analysed in ${formatDuration(report.durationMs)}`));
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

  const priorities = topPriorities(report);
  if (!options.verbose && priorities.length > 0) {
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
