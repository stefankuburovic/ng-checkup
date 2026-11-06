import { readFileSync } from 'node:fs';
import { measuresOf, type MeasureDelta } from './baseline.js';
import { TOOL } from './index.js';
import { findingIdentity } from './report/codequality.js';
import { overallScore } from './report/summary.js';
import type { FileRef, Grade, Report, Severity } from './types.js';

/**
 * `ng-checkup diff before.json after.json`: what changed between two saved
 * reports, the proof of a piece of modernization work.
 *
 * It reads the reports and nothing else, so it runs anywhere and years later.
 * Findings are matched as a whole by what they are about (`findingIdentity`,
 * the Code Quality fingerprint without the file), not file by file: a report lists
 * only a few example files per finding, so a file missing from the list says
 * nothing about the code. The measures carry the numbers.
 *
 * What only one report knows is never better or worse. A newer tool version
 * adds measures and findings, and `--only` leaves areas out, so those are
 * listed apart and the notes say why two reports may not be comparable.
 */

/** One side of the comparison, as the headers show it. */
export interface DiffSide {
  name: string;
  generatedAt: string;
  toolVersion: string;
  angularVersion?: string;
  linesOfCode: number;
  /** Undefined when nothing was graded. */
  score?: number;
}

/** One area in either report. `before` or `after` is undefined when that report does not have it. */
export interface DiffArea {
  id: string;
  title: string;
  before?: Grade;
  after?: Grade;
  /** `changed` is a move to or from `info`, which is neither better nor worse. */
  change: 'better' | 'worse' | 'same' | 'changed' | 'only-one';
}

/** A finding only one report has. */
export interface DiffFinding {
  check: string;
  severity: Severity;
  message: string;
  detail?: string;
  files?: FileRef[];
  count?: number;
}

/** What `diff` produces, which is also its JSON output. */
export interface DiffReport {
  tool: typeof TOOL;
  generatedAt: string;
  before: DiffSide;
  after: DiffSide;
  /** Report order. */
  areas: DiffArea[];
  /** Lower is better for every measure. Largest change first. */
  improved: MeasureDelta[];
  worsened: MeasureDelta[];
  /** Measures both reports have with the same value. */
  unchanged: number;
  /** Labels of the measures only one report has. Neither better nor worse. */
  measuresOnlyBefore: string[];
  measuresOnlyAfter: string[];
  /** False when a `--since` report narrowed the findings, so the two lists below say nothing and stay empty. */
  findingsCompared: boolean;
  /** In an area both reports have. Severity order. */
  newFindings: DiffFinding[];
  resolvedFindings: DiffFinding[];
  /** Why the two reports may not compare like for like. Empty when they do. */
  notes: string[];
}

/** Grades that can be ranked; `info` means nothing was graded. */
const RANK: Partial<Record<Grade, number>> = { poor: 0, fair: 1, good: 2 };
const SEVERITY_ORDER: Severity[] = ['high', 'medium', 'low', 'info'];

/**
 * A report saved with `--report x.json` or `--json`.
 *
 * @throws When the file cannot be read or is another kind of JSON: a Code
 *   Quality or SARIF report, a baseline, a fleet or history page.
 */
export function readSavedReport(path: string): Report {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Partial<Report>;
  if (!Array.isArray(record.checks) || typeof record.tool?.version !== 'string' || typeof record.project !== 'object' || record.project === null) {
    throw new Error(`${path} is not an ng-checkup JSON report: write one with --report report.json`);
  }
  return record as Report;
}

function sideOf(report: Report): DiffSide {
  const score = overallScore(report);
  return {
    name: report.project.name,
    generatedAt: report.generatedAt,
    toolVersion: report.tool.version,
    ...(report.project.angularVersion ? { angularVersion: report.project.angularVersion } : {}),
    linesOfCode: report.project.linesOfCode,
    ...(score !== undefined ? { score } : {}),
  };
}

function areaChange(before: Grade | undefined, after: Grade | undefined): DiffArea['change'] {
  if (before === undefined || after === undefined) return 'only-one';
  if (before === after) return 'same';
  const from = RANK[before];
  const to = RANK[after];
  if (from === undefined || to === undefined) return 'changed';
  return to > from ? 'better' : 'worse';
}

/** The findings of a report about the code, by check and kind. `info` findings are about the run. */
function findingsByKind(report: Report): Map<string, DiffFinding> {
  const found = new Map<string, DiffFinding>();
  for (const check of report.checks) {
    for (const finding of check.findings) {
      if (finding.severity === 'info') continue;
      const key = findingIdentity(check.id, finding.message);
      if (!found.has(key)) found.set(key, { check: check.title, severity: finding.severity, message: finding.message, ...(finding.detail ? { detail: finding.detail } : {}), ...(finding.files ? { files: finding.files } : {}), ...(finding.count !== undefined ? { count: finding.count } : {}) });
    }
  }
  return found;
}

/** Compares two saved reports. Pure: it reads only its arguments. */
export function diffReports(before: Report, after: Report): DiffReport {
  const notes: string[] = [];
  if (before.tool.version !== after.tool.version) {
    notes.push(`The reports come from different versions of the tool (${before.tool.version} and ${after.tool.version}). A measure only one of them has is listed apart and is not an improvement or a regression, but a new finding or a moved grade may come from a rule that changed and not from the code.`);
  }
  if (before.project.name !== after.project.name) notes.push(`The reports name different projects (${before.project.name} and ${after.project.name}).`);
  if (before.generatedAt > after.generatedAt) notes.push('The "after" report is older than the "before" report, so the order of the two files may be wrong.');

  const beforeChecks = new Map(before.checks.map((check) => [check.id, check]));
  const afterChecks = new Map(after.checks.map((check) => [check.id, check]));
  const areas: DiffArea[] = [...after.checks, ...before.checks.filter((check) => !afterChecks.has(check.id))].map((check) => {
    const from = beforeChecks.get(check.id)?.grade;
    const to = afterChecks.get(check.id)?.grade;
    return { id: check.id, title: check.title, ...(from ? { before: from } : {}), ...(to ? { after: to } : {}), change: areaChange(from, to) };
  });
  if (areas.some((area) => area.change === 'only-one')) notes.push('Some areas are in only one report, because of `--only`, `--skip`, the tool version or the code itself. The score averages the areas each report has, so the two scores cover different ground.');

  const measuresBefore = measuresOf(before);
  const measuresAfter = measuresOf(after);
  const improved: MeasureDelta[] = [];
  const worsened: MeasureDelta[] = [];
  let unchanged = 0;
  for (const [key, current] of measuresAfter) {
    const previous = measuresBefore.get(key);
    if (!previous) continue;
    const delta: MeasureDelta = { key, check: current.check, label: current.label, before: previous.value, after: current.value };
    if (current.value < previous.value) improved.push(delta);
    else if (current.value > previous.value) worsened.push(delta);
    else unchanged++;
  }
  const bySize = (left: MeasureDelta, right: MeasureDelta): number => Math.abs(right.after - right.before) - Math.abs(left.after - left.before) || left.key.localeCompare(right.key);

  const findingsCompared = !before.since && !after.since;
  if (!findingsCompared) notes.push('A report made with `--since` lists only the findings in the files a branch changed, so new and resolved findings are not compared. Grades, score and measures are the whole repository\'s and still are.');
  const findingsBefore = findingsByKind(before);
  const findingsAfter = findingsByKind(after);
  const inBothAreas = (key: string): boolean => beforeChecks.has(key.split('\n')[0]!) && afterChecks.has(key.split('\n')[0]!);
  const only = (from: Map<string, DiffFinding>, other: Map<string, DiffFinding>): DiffFinding[] =>
    findingsCompared
      ? [...from.entries()]
          .filter(([key]) => !other.has(key) && inBothAreas(key))
          .map(([, finding]) => finding)
          .sort((left, right) => SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity))
      : [];

  return {
    tool: TOOL,
    generatedAt: new Date().toISOString(),
    before: sideOf(before),
    after: sideOf(after),
    areas,
    improved: improved.sort(bySize),
    worsened: worsened.sort(bySize),
    unchanged,
    measuresOnlyBefore: [...measuresBefore.entries()].filter(([key]) => !measuresAfter.has(key)).map(([, measure]) => measure.label),
    measuresOnlyAfter: [...measuresAfter.entries()].filter(([key]) => !measuresBefore.has(key)).map(([, measure]) => measure.label),
    findingsCompared,
    newFindings: only(findingsAfter, findingsBefore),
    resolvedFindings: only(findingsBefore, findingsAfter),
    notes,
  };
}
