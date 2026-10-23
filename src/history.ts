import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { measuresOf } from './baseline.js';
import { runCheckup, TOOL } from './index.js';
import { overallScore } from './report/summary.js';
import type { CheckupOptions } from './types.js';

/** One point of the history: the checkup of one commit. */
export interface HistoryPoint {
  /** Full commit hash; `working tree` for the current, possibly uncommitted state. */
  commit: string;
  /** Commit date, ISO `YYYY-MM-DD`. */
  date: string;
  score?: number;
  angularVersion?: string;
  linesOfCode: number;
  /** Every measure of the run, by baseline key (`components.legacy-control-flow`). */
  measures: Record<string, number>;
}

/** What `ng-checkup history` produces. */
export interface HistoryReport {
  tool: { name: string; version: string };
  generatedAt: string;
  /** The analysed folder, as the reports name it: the repository folder's name, plus the subfolder when the run was inside one. */
  root: string;
  points: HistoryPoint[];
  /** Labels of the measures that appear in `points`, by key. */
  labels: Record<string, string>;
}

/** Why `collectHistory` cannot run. */
export class HistoryUnavailableError extends Error {
  override name = 'HistoryUnavailableError';
}

/**
 * Checks out one commit per interval and runs the checkup on each, oldest
 * first, ending with the current working tree: how the score and every
 * measure moved over the last months, without waiting months to collect it.
 *
 * Each commit is extracted with `git archive` into a temporary folder, so
 * the working tree is never touched, and analysed offline, so the only cost
 * is local: a few seconds per point. Offline means the deprecated APIs come
 * from typings already in the cache; where none are cached for an old
 * version, those measures are missing from that point rather than wrong.
 *
 * @param points How many points before the current state, one per month back.
 *   A month without a new commit repeats the previous one and is left out,
 *   so a quiet repository gets fewer points.
 * @param ignore `only` and `skip` as in a checkup run, so the score matches it.
 * @param onProgress Called before each point, for a progress line.
 * @throws `HistoryUnavailableError` outside a git repository or in a shallow clone.
 */
export async function collectHistory(root: string, options: { points?: number; ignore?: string[]; only?: string[]; skip?: string[]; onProgress?: (done: number, total: number, label: string) => void } = {}): Promise<HistoryReport> {
  const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim();
  try {
    if (git('rev-parse', '--is-inside-work-tree') !== 'true') throw new Error();
  } catch {
    throw new HistoryUnavailableError(`${root} is not in a git repository, so there is no history to read`);
  }
  if (git('rev-parse', '--is-shallow-repository') === 'true') throw new HistoryUnavailableError('this is a shallow clone, which has one commit of history; fetch the full history first (git fetch --unshallow, or fetch-depth: 0 in CI)');
  const prefix = git('rev-parse', '--show-prefix');
  const top = git('rev-parse', '--show-toplevel');

  const count = Math.max(1, options.points ?? 12);
  const now = new Date();
  // Counted back from the last commit, not from today: a repository nobody has committed to for two years
  // would otherwise get twelve months that all resolve to its last commit, and a history of one point.
  const head = git('rev-parse', 'HEAD');
  const headDate = new Date(git('show', '-s', '--format=%cI', 'HEAD'));
  const anchor = headDate < now ? headDate : now;
  // A clean working tree is HEAD; the last point then stands for both, dated at the commit.
  const clean = git('status', '--porcelain', '--', '.') === '';
  const commits: Array<{ commit: string; date: string }> = [];
  for (let monthsBack = count; monthsBack >= 1; monthsBack--) {
    const before = new Date(anchor.getFullYear(), anchor.getMonth() - monthsBack + 1, 1).toISOString().slice(0, 10);
    const commit = git('rev-list', '-1', '--first-parent', `--before=${before}`, 'HEAD');
    if (!commit || (clean && commit === head) || commits.some((entry) => entry.commit === commit)) continue;
    commits.push({ commit, date: git('show', '-s', '--format=%cs', commit) });
  }
  // With uncommitted changes the last commit is a state of its own, between the last month and the working tree.
  if (!clean && !commits.some((entry) => entry.commit === head)) commits.push({ commit: head, date: headDate.toISOString().slice(0, 10) });

  const checkup: CheckupOptions = { offline: true, ignore: options.ignore, only: options.only, skip: options.skip };
  const points: HistoryPoint[] = [];
  const labels: Record<string, string> = {};
  const total = commits.length + 1;
  const record = (report: Awaited<ReturnType<typeof runCheckup>>, commit: string, date: string): void => {
    const measures: Record<string, number> = {};
    for (const [key, measure] of measuresOf(report)) {
      measures[key] = measure.value;
      labels[key] = measure.label;
    }
    const score = overallScore(report);
    points.push({ commit, date, ...(score !== undefined ? { score } : {}), ...(report.project.angularVersion ? { angularVersion: report.project.angularVersion } : {}), linesOfCode: report.project.linesOfCode, measures });
  };

  for (const [index, entry] of commits.entries()) {
    options.onProgress?.(index, total, `${entry.date} ${entry.commit.slice(0, 7)}`);
    const directory = mkdtempSync(join(tmpdir(), 'ng-checkup-history-'));
    try {
      // `git archive … | tar -x`, without a shell: the archive is piped through execFileSync's input.
      const archive = execFileSync('git', ['-C', top, 'archive', '--format=tar', entry.commit, ...(prefix ? [prefix] : [])], { maxBuffer: 2 * 1024 * 1024 * 1024 });
      execFileSync('tar', ['-x', '-C', directory], { input: archive });
      record(await runCheckup(join(directory, prefix), checkup), entry.commit, entry.date);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  options.onProgress?.(commits.length, total, 'working tree');
  record(await runCheckup(root, checkup), 'working tree', (clean ? headDate : now).toISOString().slice(0, 10));
  return { tool: TOOL, generatedAt: now.toISOString(), root: prefix ? `${basename(top)}/${prefix.replace(/\/$/, '')}` : basename(top), points, labels };
}

export { movedMeasures } from './report/charts.js';
