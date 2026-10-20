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

/** A baseline of the report's current measures. */
export function createBaseline(report: Report, today = report.generatedAt.slice(0, 10)): Baseline {
  const measures: Record<string, number> = {};
  for (const [key, measure] of [...measuresOf(report)].sort(([left], [right]) => left.localeCompare(right))) measures[key] = measure.value;
  return { version: 1, tool: `${report.tool.name} ${report.tool.version}`, updated: today, measures };
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
  if (record['version'] !== 1 || typeof measures !== 'object' || measures === null || Array.isArray(measures) || !Object.values(measures).every((value) => typeof value === 'number')) {
    throw new Error(`${path} is not an ng-checkup baseline (expected version 1 and numeric measures). Recreate it with ng-checkup baseline --force.`);
  }
  return { version: 1, tool: String(record['tool'] ?? ''), updated: String(record['updated'] ?? ''), measures: measures as Record<string, number> };
}

/**
 * Compares a report with a baseline. A measure the report has no value for
 * (its check graded `info` this time) is skipped rather than counted as an
 * improvement: it was not measured, not fixed.
 */
export function compareWithBaseline(report: Report, baseline: Baseline, path: string): BaselineComparison {
  const regressions: MeasureDelta[] = [];
  const improvements: MeasureDelta[] = [];
  const added: string[] = [];
  for (const [key, current] of measuresOf(report)) {
    const before = baseline.measures[key];
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

/**
 * The measures that would go up if `next` replaced `previous`. Updating a
 * baseline may only lower numbers; raising one needs `--force`, which is the
 * moment someone has to say why in review. Empty for a first baseline.
 */
export function baselineIncreases(previous: Baseline | undefined, next: Baseline): Array<{ key: string; before: number; after: number }> {
  if (!previous) return [];
  return Object.entries(next.measures)
    .filter(([key, value]) => previous.measures[key] !== undefined && value > previous.measures[key]!)
    .map(([key, after]) => ({ key, before: previous.measures[key]!, after }));
}
