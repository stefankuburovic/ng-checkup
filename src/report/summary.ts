import type { CheckResult, Finding, Grade, ProjectSummary, Report, Severity } from '../types.js';

/** Points per grade for the overall score. `info` is absent: it never counts. */
const GRADE_POINTS: Record<Exclude<Grade, 'info'>, number> = { good: 100, fair: 60, poor: 20 };

/** Severity order, most urgent first. */
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

/** A finding together with the check it belongs to, for the cross-check priority list. */
export interface Priority {
  check: CheckResult;
  finding: Finding;
}

/**
 * The overall score, 0 to 100: the average of the graded areas at 100 for
 * good, 60 for fair and 20 for poor. Areas graded `info` are left out, so a
 * repository is not marked down for what the tool could not measure.
 * Undefined when nothing was graded at all.
 *
 * A deliberately simple formula. Every report prints it next to the score,
 * because a number whose derivation is hidden invites arguing with it instead
 * of with the findings.
 */
export function overallScore(report: Pick<Report, 'checks'>): number | undefined {
  const graded = report.checks.filter((check): check is CheckResult & { grade: Exclude<Grade, 'info'> } => check.grade !== 'info');
  if (graded.length === 0) return undefined;
  return Math.round(graded.reduce((sum, check) => sum + GRADE_POINTS[check.grade], 0) / graded.length);
}

/**
 * The titles of a project's poor and fair areas, in report order, for the
 * per-project tables. Titles come from the whole-workspace checks, since a
 * project row stores only the grade per check id.
 */
export function projectAreas(row: ProjectSummary, report: Pick<Report, 'checks'>): { poor: string[]; fair: string[] } {
  const titled = report.checks.filter((check) => row.grades[check.id] !== undefined);
  return {
    poor: titled.filter((check) => row.grades[check.id] === 'poor').map((check) => check.title),
    fair: titled.filter((check) => row.grades[check.id] === 'fair').map((check) => check.title),
  };
}

/** The sentence every format prints under the score. */
export const SCORE_EXPLANATION = 'Average of the graded areas: good counts 100, fair 60, poor 20. Areas marked info are not counted.';

/**
 * The findings to act on first, across all checks: every `high` finding,
 * then `medium` ones if fewer than `limit` are high, in report order within a
 * severity. Low and info findings never make the list.
 */
export function topPriorities(report: Report, limit = 5): Priority[] {
  return report.checks
    .flatMap((check) => check.findings.map((finding) => ({ check, finding })))
    .filter(({ finding }) => finding.severity === 'high' || finding.severity === 'medium')
    .sort((left, right) => SEVERITY_RANK[left.finding.severity] - SEVERITY_RANK[right.finding.severity])
    .slice(0, limit);
}

/** Display label of a grade. */
export function gradeLabel(grade: Grade): string {
  return { good: 'Good', fair: 'Fair', poor: 'Poor', info: 'Info' }[grade];
}

/** Display label of a severity. */
export function severityLabel(severity: Severity): string {
  return { high: 'High', medium: 'Medium', low: 'Low', info: 'Note' }[severity];
}

/** `path:line`, or just `path` when the location has no line. */
export function formatLocation(ref: { path: string; line?: number }): string {
  return ref.line === undefined ? ref.path : `${ref.path}:${ref.line}`;
}

/** "1.5 s" or "820 ms". */
export function formatDuration(milliseconds: number): string {
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)} s` : `${milliseconds} ms`;
}

/** The workspace kind as a reader would name it. */
export function kindLabel(kind: Report['project']['kind']): string {
  return { 'angular-cli': 'Angular CLI', nx: 'Nx', unknown: 'unknown workspace' }[kind];
}

/**
 * How many more files a finding covers than it lists. 0 when it lists them
 * all, and 0 when it lists none: then `count` is a number of occurrences in
 * the message, not of files, and "and 12 more" under an empty list would
 * read as a rendering bug.
 */
export function remainingCount(finding: Finding): number {
  const listed = finding.files?.length ?? 0;
  return listed === 0 ? 0 : Math.max(0, (finding.count ?? 0) - listed);
}
