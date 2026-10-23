import { execFileSync } from 'node:child_process';

/** How often each file changed recently, from git, as `AnalysisContext.churn`. */
export interface Churn {
  /** The window, as git understands it (`12.months`). */
  since: string;
  /** Commits in the window that touched the analysed folder, merges left out. */
  commits: number;
  /** Commits per report path (relative to the analysed root). */
  files: Map<string, number>;
}

/** Why there is no churn to report. */
export type ChurnUnavailable = 'not a git repository' | 'shallow clone' | 'git not installed';

/**
 * Commits per file over the last `since`, for the files under `root`.
 *
 * A file that is both large and changed often is where a refactoring pays
 * off first: it is read and edited all the time, so its size costs on every
 * change. Static analysis cannot see that; the history can. `--relative`
 * keeps paths relative to `root` and limits the log to it, so a checkup of
 * one folder of a larger repository counts that folder only.
 *
 * @returns The reason instead when there is no usable history: not a git
 *   repository, or a shallow clone (the remote mode and CI checkouts with
 *   `fetch-depth: 1`), whose history is one commit and would rank nothing.
 */
export function readChurn(root: string, since = '12.months'): Churn | ChurnUnavailable {
  const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  try {
    if (git('rev-parse', '--is-inside-work-tree').trim() !== 'true') return 'not a git repository';
  } catch (error) {
    return (error as { code?: string }).code === 'ENOENT' ? 'git not installed' : 'not a git repository';
  }
  try {
    if (git('rev-parse', '--is-shallow-repository').trim() === 'true') return 'shallow clone';
    const log = git('log', `--since=${since}`, '--no-merges', '--relative', '--format=%x01', '--name-only', '--', '.');
    const files = new Map<string, number>();
    let commits = 0;
    for (const block of log.split('\u0001')) {
      const paths = block.split('\n').map((line) => line.trim()).filter(Boolean);
      if (paths.length === 0) continue;
      commits++;
      for (const path of new Set(paths)) files.set(path, (files.get(path) ?? 0) + 1);
    }
    return { since, commits, files };
  } catch {
    return 'not a git repository';
  }
}
