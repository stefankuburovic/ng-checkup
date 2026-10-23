import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { measuresOf } from './baseline.js';
import { overallScore } from './report/summary.js';
import type { Report } from './types.js';

/** One run of the default branch, as the trend file keeps it. */
export interface TrendPoint {
  /** ISO date of the run, `YYYY-MM-DD`. */
  date: string;
  /** The commit that was checked, when CI or git could say. */
  commit?: string;
  score?: number;
  /**
   * Initial bundle of the largest application, in bytes, from the build's
   * stats file. Only there when the run found one: the bundle is what a
   * trend can follow from now on but never backwards, since an old commit
   * cannot be rebuilt reliably.
   */
  initialBytes?: number;
  /** Every baseline measure of the run, by key. */
  measures: Record<string, number>;
}

/** What the reports show of a trend. Attached to `Report.trend`. */
export interface TrendSummary {
  /** The window the deltas cover, in days. */
  days: number;
  /** The point compared with: the last one at least `days` old, else the oldest there is. Undefined on the first run. */
  since?: TrendPoint;
  /** This run. */
  now: TrendPoint;
  /** The recorded points of the window plus this run, oldest first, for a sparkline. */
  recent: TrendPoint[];
  /** Measures that moved most between `since` and now, largest change first, at most three. */
  moved: Array<{ key: string; label: string; before: number; after: number }>;
}

/** The trend file's shape on disk. */
interface TrendFile {
  tool: 'ng-checkup';
  points: TrendPoint[];
}

/** Points kept in the file. Two years of daily default-branch runs, and a file small enough for any CI cache. */
const MAX_POINTS = 730;

/**
 * The points of a trend file, oldest first. A missing, empty or unreadable
 * file is no trend yet (the first run on a branch, or a cache that expired),
 * never an error: the trend is a nicety, and a CI job must not fail over it.
 */
export function readTrend(path: string): TrendPoint[] {
  if (!existsSync(path)) return [];
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as Partial<TrendFile>;
    return Array.isArray(file.points) ? file.points.filter((point) => typeof point?.date === 'string' && typeof point.measures === 'object') : [];
  } catch {
    return [];
  }
}

/** This run as a trend point. */
export function trendPoint(report: Report, commit?: string): TrendPoint {
  const measures: Record<string, number> = {};
  for (const [key, measure] of measuresOf(report)) measures[key] = measure.value;
  const score = overallScore(report);
  return {
    date: report.generatedAt.slice(0, 10),
    ...(commit ? { commit } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(report.bundle ? { initialBytes: report.bundle.initialBytes } : {}),
    measures,
  };
}

/**
 * Adds `point` to the file and writes it: a rerun of the same commit replaces
 * its earlier point instead of adding a duplicate, and only the newest
 * `MAX_POINTS` are kept.
 */
export function recordTrend(path: string, points: TrendPoint[], point: TrendPoint): TrendPoint[] {
  const next = [...points.filter((existing) => !(point.commit && existing.commit === point.commit)), point].sort((left, right) => left.date.localeCompare(right.date)).slice(-MAX_POINTS);
  mkdirSync(dirname(path), { recursive: true });
  const file: TrendFile = { tool: 'ng-checkup', points: next };
  writeFileSync(path, `${JSON.stringify(file)}\n`);
  return next;
}

/**
 * How the score, the bundle and the measures moved over the last `days`:
 * this run against the last recorded point at least `days` old, or the
 * oldest point when the trend is younger than that. A pull request is
 * compared with what the default branch recorded, so the line reads as
 * "where the codebase is heading", not as this change's own effect, which is
 * what the baseline comparison is for.
 *
 * @param points Recorded points, oldest first; this run's point is not among them.
 * @returns Undefined when nothing has been recorded yet.
 */
export function summarizeTrend(points: TrendPoint[], now: TrendPoint, labels: Record<string, string>, days = 30): TrendSummary | undefined {
  // A rerun of the commit already recorded is not its own past.
  const earlier = points.filter((point) => point.date <= now.date && !(now.commit !== undefined && point.commit === now.commit));
  if (earlier.length === 0) return undefined;
  const cutoff = new Date(Date.parse(now.date) - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const since = [...earlier].reverse().find((point) => point.date <= cutoff) ?? earlier[0]!;
  const recent = [...earlier.filter((point) => point.date >= since.date).slice(-11), now];
  const moved = Object.keys(now.measures)
    .filter((key) => since.measures[key] !== undefined && since.measures[key] !== now.measures[key])
    .map((key) => ({ key, label: labels[key] ?? key, before: since.measures[key]!, after: now.measures[key]! }))
    .sort((left, right) => Math.abs(right.after - right.before) - Math.abs(left.after - left.before) || left.key.localeCompare(right.key))
    .slice(0, 3);
  return { days, since, now, recent, moved };
}

/** `▁▃▅█`: values as block characters, lowest to highest, for a line of text. Empty for fewer than two values. */
export function sparkline(values: number[]): string {
  if (values.length < 2) return '';
  const blocks = '▁▂▃▄▅▆▇█';
  const low = Math.min(...values);
  const high = Math.max(...values);
  return values.map((value) => blocks[high === low ? 3 : Math.round(((value - low) / (high - low)) * (blocks.length - 1))]).join('');
}

/** `+4`, `-12`, `±0`. */
function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '±0';
}

/** `812 kB`, the way a bundle size reads in a sentence. */
function kilobytes(bytes: number): string {
  return `${Math.round(bytes / 1000).toLocaleString('en-US').replace(/,/g, ' ')} kB`;
}

/**
 * The trend as one sentence for the comment, the Markdown report and the
 * terminal: "Score 72, +4 since 2026-09-23 ▃▄▄▆▇ · initial bundle 812 kB,
 * +23 kB". Undefined when there is nothing to compare.
 */
export function trendSentence(trend: TrendSummary): string | undefined {
  const { since, now } = trend;
  if (!since) return undefined;
  const parts: string[] = [];
  if (now.score !== undefined && since.score !== undefined) {
    const line = sparkline(trend.recent.map((point) => point.score).filter((score): score is number => score !== undefined));
    parts.push(`Score ${now.score}, ${signed(now.score - since.score)} since ${since.date}${line ? ` ${line}` : ''}`);
  }
  if (now.initialBytes !== undefined && since.initialBytes !== undefined) {
    const delta = Math.round((now.initialBytes - since.initialBytes) / 1000);
    parts.push(`initial bundle ${kilobytes(now.initialBytes)}, ${signed(delta)} kB`);
  } else if (now.initialBytes !== undefined) {
    parts.push(`initial bundle ${kilobytes(now.initialBytes)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
