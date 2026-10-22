import { watch, type FSWatcher } from 'node:fs';
import { extname, resolve } from 'node:path';
import { compareWithBaseline, createBaseline } from './baseline.js';
import { overallScore } from './report/summary.js';
import type { Report } from './types.js';

/** Directories whose changes never affect a report: dependencies, build output, caches, VCS. */
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', 'tmp', 'out-tsc']);

/** Extensions of the files a report is computed from: sources, templates, configs and lockfiles. */
const WATCHED_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.html', '.json', '.lock', '.yaml']);

/** Options of `watchCheckup`. */
export interface WatchOptions {
  root: string;
  /** Runs one checkup. Called once at start and again after every batch of relevant changes. */
  run: () => Promise<void>;
  /** Quiet period after the last change before a run starts, in milliseconds. Editors save in bursts. */
  debounceMs?: number;
  /**
   * Absolute paths whose changes are ignored, on top of the ignored
   * directories. The CLI passes its own report files here: a report written
   * inside the repository would otherwise trigger the next run, forever.
   */
  ignorePaths?: string[];
  /** Called with an error thrown by `run`; the watch keeps going. */
  onError?: (error: unknown) => void;
}

/**
 * True when a change to `relativePath` (relative to the watched root) can
 * change the report. Dot directories (`.git`, `.angular`, `.nx`) and the
 * ignored directories are skipped at any depth, because Nx and the Angular
 * CLI write caches there on every build, and a watch that reacts to a build
 * would re-run for no reason.
 */
export function isRelevantChange(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/);
  if (parts.slice(0, -1).some((part) => part.startsWith('.') || IGNORED_DIRECTORIES.has(part))) return false;
  return WATCHED_EXTENSIONS.has(extname(relativePath));
}

/**
 * Runs `run` now and again whenever a relevant file under `root` changes,
 * until the returned function is called.
 *
 * Uses one recursive `fs.watch` (native on macOS and Windows, and on Linux
 * since Node 20), so no dependency and no polling. Runs never overlap:
 * changes during a run queue exactly one more run after it, which is what a
 * user saving several files during a slow run wants to see.
 *
 * @returns A function that stops watching and resolves once a run in progress has finished.
 */
export function watchCheckup(options: WatchOptions): () => Promise<void> {
  const root = resolve(options.root);
  const ignored = new Set((options.ignorePaths ?? []).map((path) => resolve(path)));
  const debounceMs = options.debounceMs ?? 250;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let pending = false;
  let stopped = false;
  // macOS FSEvents replays changes made just before the watch began (the
  // files a fresh checkout or a test just wrote). The first run reads that
  // state anyway, so events in this window would only cause a second,
  // identical run.
  const settledAt = Date.now() + 100;

  const start = (): void => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    running = options
      .run()
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running = undefined;
        if (pending) {
          pending = false;
          start();
        }
      });
  };

  const watcher: FSWatcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename || Date.now() < settledAt) return;
    const relative = filename.toString();
    if (ignored.has(resolve(root, relative)) || !isRelevantChange(relative)) return;
    clearTimeout(timer);
    timer = setTimeout(start, debounceMs);
  });
  start();

  return async () => {
    stopped = true;
    clearTimeout(timer);
    watcher.close();
    await running;
  };
}

/**
 * The lines a watch prints under each report: the score now against the
 * score when the watch started, and every measure that moved since then.
 *
 * The comparison is against the first run of the session, not the previous
 * run, so a fix stays visible on screen while the user keeps working instead
 * of vanishing at the next save. It reuses the baseline arithmetic, so "went
 * down" means the same as in `--fail-on regression`.
 */
export function describeProgress(start: Report, current: Report, color = false): string {
  const paint = (code: number, text: string): string => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const before = overallScore(start);
  const after = overallScore(current);
  const lines: string[] = [];
  if (before !== undefined && after !== undefined) {
    const delta = after - before;
    const change = delta === 0 ? 'no change' : paint(delta > 0 ? 32 : 31, `${delta > 0 ? '+' : ''}${delta}`);
    lines.push(`Score ${before} -> ${after} (${change} since the watch started)`);
  }
  const comparison = compareWithBaseline(current, createBaseline(start), '');
  for (const entry of comparison.improvements) lines.push(`  ${paint(32, 'down')} ${entry.label}: ${entry.before} -> ${entry.after}`);
  for (const entry of comparison.regressions) lines.push(`  ${paint(31, 'up')}   ${entry.label}: ${entry.before} -> ${entry.after}`);
  return lines.join('\n');
}

