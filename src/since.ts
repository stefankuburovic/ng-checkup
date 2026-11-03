import { execFileSync } from 'node:child_process';
import type { CheckResult, FileRef } from './types.js';

/**
 * `--since <ref>`: a report about the files a branch changed.
 *
 * The analysis still reads the whole repository, because a cycle, an unused
 * file or a missing translation key is only visible against all the others,
 * and the grades, score and measures stay the whole repository's: a baseline
 * compared against them must not change meaning with the branch. What
 * narrows is the findings: each keeps only the files the branch changed, and
 * a finding with none of them, or with no files at all (the Angular version,
 * a runner), is left out. That is the list a pull-request comment wants: what
 * this change touches, not the backlog the repository already had.
 */

/** What a `--since` run compared against, for the report header. */
export interface SinceInfo {
  /** The ref as given (`origin/main`). */
  ref: string;
  /** The merge base of `ref` and `HEAD`, abbreviated, which is what the files were compared with. */
  base: string;
  /** Files changed since the merge base, committed or not, untracked ones included. */
  changedFiles: number;
}

/** A `--since` ref git could not resolve, or a root that is not in a git checkout. */
export class SinceError extends Error {}

/**
 * Report paths of the files changed between the merge base of `ref` and
 * `HEAD` and the working tree, plus untracked files: what a pull request from
 * this checkout would contain, including what is not committed yet.
 *
 * The merge base, not `ref` itself, so that commits that landed on the target
 * branch after this one branched off do not count as this branch's changes;
 * that is what `git diff ref...HEAD` and every code host's pull-request view
 * compare with too.
 *
 * @throws SinceError outside a git checkout, or when `ref` names nothing.
 *   A shallow clone (`fetch-depth: 1`) usually lacks the target branch, so
 *   the message says to fetch it.
 */
export function changedFilesSince(root: string, ref: string): { base: string; files: Set<string> } {
  const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let base: string;
  try {
    base = git('merge-base', ref, 'HEAD');
  } catch {
    throw new SinceError(`--since ${ref}: git found no common ancestor of ${ref} and HEAD in ${root}. Outside a git checkout this cannot work; in CI, fetch the target branch first (actions/checkout with fetch-depth: 0, or git fetch origin ${ref.replace(/^origin\//, '')}).`);
  }
  // `--relative` gives paths relative to the analysed root and leaves out everything outside it.
  const changed = git('diff', '--name-only', '--relative', '--diff-filter=d', base).split('\n');
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n');
  return { base: base.slice(0, 12), files: new Set([...changed, ...untracked].filter((path) => path.length > 0)) };
}

/**
 * The findings of `checks` narrowed to `changed` (see the module comment),
 * capped at `maxExamples` again. `count` becomes the number of changed files
 * the finding names. Grades, summaries, metrics and measures are left as
 * they are. Does not mutate its argument.
 *
 * @param checks Results computed with no cap on examples, so that no
 *   changed file is lost to a cap before the narrowing.
 */
export function narrowToChanged(checks: CheckResult[], changed: Set<string>, maxExamples: number): CheckResult[] {
  return checks.map((check) => ({
    ...check,
    findings: check.findings.flatMap((finding) => {
      const files: FileRef[] = (finding.files ?? []).filter((file) => changed.has(file.path));
      if (files.length === 0) return [];
      return [{ ...finding, files: files.slice(0, maxExamples), count: files.length }];
    }),
  }));
}
