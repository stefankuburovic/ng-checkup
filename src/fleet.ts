import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runCheckup, TOOL } from './index.js';
import { cloneRemote, parseRemote } from './remote.js';
import { overallScore } from './report/summary.js';
import type { Grade } from './types.js';

/**
 * `ng-checkup fleet <list>`: one page across many repositories.
 *
 * For an agency or a company with ten or more front ends, the question is
 * not how one app is doing but which one to look at first. Each entry of the
 * list is checked as a run of its own would check it (a local folder as it
 * is, a remote one cloned shallow into a temporary folder and deleted), and
 * the page ranks them worst first with the Angular version, the score and a
 * grade per area. An entry that fails (a clone that is refused, a folder
 * that is gone) is a row saying why, not the end of the run.
 */

/** One repository's row. */
export interface FleetRow {
  /** The line of the list as written: `../shop`, `github:acme/admin#release`. */
  entry: string;
  /** The workspace name from its package.json; the entry when the run failed. */
  name: string;
  angularVersion?: string;
  /** Undefined when nothing was graded, or the run failed. */
  score?: number;
  /** Grade per check id, info areas included. */
  grades: Record<string, Grade>;
  highFindings: number;
  linesOfCode: number;
  /** The commit a remote entry was checked at, abbreviated. */
  commit?: string;
  /** Why the entry could not be checked; the other fields are empty then. */
  error?: string;
}

/** What `fleet` produces. */
export interface FleetReport {
  tool: typeof TOOL;
  generatedAt: string;
  /** Worst score first; failed entries last, in list order. */
  rows: FleetRow[];
  /** Check ids and titles in report order, for the table's columns. */
  areas: Array<{ id: string; title: string }>;
}

/**
 * The entries of a list file: one per line, a local path (relative to the
 * file) or a remote repository as `ng-checkup <repository>` takes it.
 * Blank lines and `#` comments are skipped.
 *
 * @throws When the file cannot be read or names no entry.
 */
export function readFleetList(path: string): Array<{ entry: string; target: string }> {
  const base = dirname(resolve(path));
  const entries = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#(?![\w-]*$).*$|\s+#.*$/, '').trim())
    .filter((line) => line.length > 0)
    .map((entry) => ({ entry, target: parseRemote(entry) ? entry : resolve(base, entry) }));
  if (entries.length === 0) throw new Error(`${path} names no repository: one local path or github:owner/repo per line`);
  return entries;
}

/**
 * Checks every entry, one at a time (clones and analyses are both heavy,
 * and the order of the progress lines should read as the list does).
 *
 * @param options.online Ask the npm registry and osv.dev, as a run without
 *   `--offline` does. Off by default: across many repositories the lookups
 *   are most of the time, and the comparison is between the repositories.
 */
export async function runFleet(entries: Array<{ entry: string; target: string }>, options: { online?: boolean; onProgress?: (done: number, total: number, entry: string) => void } = {}): Promise<FleetReport> {
  const rows: FleetRow[] = [];
  let areas: FleetReport['areas'] = [];
  for (const [index, { entry, target }] of entries.entries()) {
    options.onProgress?.(index, entries.length, entry);
    const remote = parseRemote(entry);
    let clone: ReturnType<typeof cloneRemote> | undefined;
    try {
      if (remote) clone = cloneRemote(remote);
      // A missing folder would analyse as an empty repository and rank as a clean one.
      else if (!existsSync(target)) throw new Error(`no such folder: ${target}`);
      const report = await runCheckup(clone ? clone.directory : target, { offline: !options.online, compareNextMajor: options.online ?? false });
      if (areas.length === 0) areas = report.checks.map((check) => ({ id: check.id, title: check.title }));
      rows.push({
        entry,
        name: report.project.name,
        ...(report.project.angularVersion ? { angularVersion: report.project.angularVersion } : {}),
        ...(overallScore(report) !== undefined ? { score: overallScore(report)! } : {}),
        grades: Object.fromEntries(report.checks.map((check) => [check.id, check.grade])),
        highFindings: report.checks.reduce((sum, check) => sum + check.findings.filter((finding) => finding.severity === 'high').length, 0),
        linesOfCode: report.project.linesOfCode,
        ...(clone ? { commit: clone.commit.slice(0, 7) } : {}),
      });
    } catch (error) {
      rows.push({ entry, name: entry, grades: {}, highFindings: 0, linesOfCode: 0, error: error instanceof Error ? error.message : String(error) });
    } finally {
      clone?.remove();
    }
  }
  const failed = rows.filter((row) => row.error);
  const checked = rows.filter((row) => !row.error).sort((left, right) => (left.score ?? 101) - (right.score ?? 101));
  return { tool: TOOL, generatedAt: new Date().toISOString(), rows: [...checked, ...failed], areas };
}
