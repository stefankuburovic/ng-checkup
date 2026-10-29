import { existsSync, readFileSync } from 'node:fs';
import type { Report } from './types.js';

/** The file `ng-checkup baseline` writes and every run compares against, in the analysed root. */
export const BASELINE_FILE = 'ng-checkup.baseline.json';

/**
 * Recorded measures of one point in time.
 *
 * Kept deliberately flat (`"type-safety.explicit-any": 28`) and with sorted
 * keys, because it is committed and reviewed: a merge request that lowers a
 * number shows as a one-line diff, and one that raises it stands out.
 */
export interface Baseline {
  version: 1;
  /** `ng-checkup <version>` that wrote it. */
  tool: string;
  /** Date of the last update, `YYYY-MM-DD`. */
  updated: string;
  /** `checkId.measureId` to its value. Lower is better for every one. */
  measures: Record<string, number>;
  /**
   * The same per project of a multi-project workspace, by project name: the
   * rows of the per-project table, so the code checks only. A `--project` run
   * compares against its project's entry. Absent for a single-project
   * workspace and in baselines written before 1.5.0, which still read: the
   * field is additive, so `version` stays 1.
   */
  projects?: Record<string, Record<string, number>>;
}

/** One measure that moved against the baseline. */
export interface MeasureDelta {
  /** `checkId.measureId`. */
  key: string;
  check: string;
  label: string;
  before: number;
  after: number;
}

/** How a report compares with a baseline. Attached to `Report.baseline`. */
export interface BaselineComparison {
  /** The baseline file, as given. */
  path: string;
  /** Measures that went up: what `--fail-on regression` fails on. */
  regressions: MeasureDelta[];
  /** Measures that went down: run `ng-checkup baseline` to lock them in. */
  improvements: MeasureDelta[];
  /** Measures the baseline does not know yet, e.g. from a newer ng-checkup. Never a failure. */
  added: string[];
}

/** Every measure of a report under its baseline key, with its check's title for display. */
export function measuresOf(report: Report): Map<string, { check: string; label: string; value: number }> {
  const result = new Map<string, { check: string; label: string; value: number }>();
  for (const check of report.checks) {
    for (const measure of check.measures ?? []) result.set(`${check.id}.${measure.id}`, { check: check.title, label: measure.label, value: measure.value });
  }
  return result;
}

/** The entries of a measure record sorted by key, so the committed file diffs line by line. */
function sorted(measures: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(measures).sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * A baseline of the report's current measures, with one entry per row of its
 * per-project table when it has one (a whole-workspace run of a workspace with
 * two or more Angular projects).
 */
export function createBaseline(report: Report, today = report.generatedAt.slice(0, 10)): Baseline {
  const measures = sorted(Object.fromEntries([...measuresOf(report)].map(([key, measure]) => [key, measure.value])));
  const projects = report.projects?.length
    ? Object.fromEntries([...report.projects].sort((left, right) => left.name.localeCompare(right.name)).map((row) => [row.name, sorted(row.measures)]))
    : undefined;
  return { version: 1, tool: `${report.tool.name} ${report.tool.version}`, updated: today, measures, ...(projects ? { projects } : {}) };
}

/**
 * The recorded measures a run compares with: the workspace's, or with
 * `project` that project's entry. Undefined when the baseline has no entry
 * for the project (written before 1.5.0, or before the project existed), which
 * is not the same as an entry without measures.
 */
export function baselineMeasures(baseline: Baseline, project?: string): Record<string, number> | undefined {
  return project === undefined ? baseline.measures : baseline.projects?.[project];
}

/** The baseline as committed: two-space JSON with a final newline. */
export function serializeBaseline(baseline: Baseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

/**
 * Reads a baseline file. Undefined when it does not exist.
 *
 * @throws On malformed content. A broken baseline must stop a CI run rather
 *   than compare against nothing and pass.
 */
export function readBaseline(path: string): Baseline | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const measures = record['measures'];
  const projects = record['projects'];
  if (record['version'] !== 1 || !isMeasureRecord(measures) || (projects !== undefined && !(isRecord(projects) && Object.values(projects).every(isMeasureRecord)))) {
    throw new Error(`${path} is not an ng-checkup baseline (expected version 1 and numeric measures). Recreate it with ng-checkup baseline --force.`);
  }
  return {
    version: 1,
    tool: String(record['tool'] ?? ''),
    updated: String(record['updated'] ?? ''),
    measures,
    ...(projects !== undefined ? { projects: projects as Record<string, Record<string, number>> } : {}),
  };
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A plain object whose every value is a number: the shape of `measures` and of each `projects` entry. */
function isMeasureRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'number');
}

/**
 * Compares a report with a baseline. A measure the report has no value for
 * (its check graded `info` this time) is skipped rather than counted as an
 * improvement: it was not measured, not fixed.
 *
 * With `project`, the report is a `--project` run and is compared with that
 * project's entry. Its Angular version and package measures are not in the
 * entry, since every project shares them, so they come out as `added`, which
 * never fails: the whole-workspace run is where those are held. A project the
 * baseline has no entry for compares as all `added`; callers that need one
 * check `baselineMeasures` first.
 */
export function compareWithBaseline(report: Report, baseline: Baseline, path: string, project?: string): BaselineComparison {
  const regressions: MeasureDelta[] = [];
  const improvements: MeasureDelta[] = [];
  const added: string[] = [];
  const recorded = baselineMeasures(baseline, project) ?? {};
  for (const [key, current] of measuresOf(report)) {
    const before = recorded[key];
    if (before === undefined) {
      added.push(key);
      continue;
    }
    const delta: MeasureDelta = { key, check: current.check, label: current.label, before, after: current.value };
    if (current.value > before) regressions.push(delta);
    else if (current.value < before) improvements.push(delta);
  }
  return { path, regressions, improvements, added };
}

/** One recorded number that changed between two baselines. Project keys read `project:checkId.measureId`. */
export interface BaselineChange {
  key: string;
  before: number;
  after: number;
}

/**
 * Every number both baselines record, workspace first and then each project
 * under `project:` keys, with its value in each. A project or a measure only
 * one of them knows is left out: it is new or gone, not better or worse.
 */
function commonMeasures(previous: Baseline, next: Baseline): BaselineChange[] {
  const pairs = (prefix: string, before: Record<string, number>, after: Record<string, number>): BaselineChange[] =>
    Object.entries(after)
      .filter(([key]) => before[key] !== undefined)
      .map(([key, value]) => ({ key: `${prefix}${key}`, before: before[key]!, after: value }));
  return [
    ...pairs('', previous.measures, next.measures),
    ...Object.entries(next.projects ?? {}).flatMap(([name, measures]) => {
      const before = previous.projects?.[name];
      return before ? pairs(`${name}:`, before, measures) : [];
    }),
  ];
}

/**
 * The measures that would go up if `next` replaced `previous`, the
 * workspace's and each project's. Updating a baseline may only lower numbers;
 * raising one needs `--force`, which is the moment someone has to say why in
 * review. Empty for a first baseline. A project's number can rise while the
 * workspace's stays put, when code moves from one project to another; that is
 * still refused, because the team owning the project gates on it.
 */
export function baselineIncreases(previous: Baseline | undefined, next: Baseline): BaselineChange[] {
  return previous ? commonMeasures(previous, next).filter((change) => change.after > change.before) : [];
}

/** The measures that went down from `previous` to `next`, the workspace's and each project's. Empty for a first baseline. */
export function baselineDecreases(previous: Baseline | undefined, next: Baseline): BaselineChange[] {
  return previous ? commonMeasures(previous, next).filter((change) => change.after < change.before) : [];
}
