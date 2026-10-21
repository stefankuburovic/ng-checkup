import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A repository named on the command line instead of a local path. */
export interface RemoteRepository {
  /** What `git` clones. */
  url: string;
  /** A branch, tag or commit SHA; undefined for the default branch. */
  ref?: string;
  /** `github.com/owner/repo`, for the report header. */
  label: string;
}

/**
 * Recognises a repository argument: `github:owner/repo`, `gitlab:owner/repo`
 * and `bitbucket:owner/repo` (each with an optional `#ref`), a
 * `https://github.com/owner/repo` page URL (also `/tree/<ref>`), or any
 * `https://…` / `git@…` URL ending in `.git`. Undefined for anything else,
 * which the CLI then treats as a local path.
 */
export function parseRemote(argument: string): RemoteRepository | undefined {
  const [spec, hashRef] = argument.split('#', 2) as [string, string | undefined];
  const shorthand = /^(github|gitlab|bitbucket):([\w.-]+\/[\w.-]+)$/.exec(spec);
  if (shorthand) {
    const host = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[shorthand[1] as 'github' | 'gitlab' | 'bitbucket'];
    const path = shorthand[2]!.replace(/\.git$/, '');
    return { url: `https://${host}/${path}.git`, ...(hashRef ? { ref: hashRef } : {}), label: `${host}/${path}` };
  }
  const page = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/(?:-\/)?tree\/([^?#]+))?\/?$/.exec(spec);
  if (page) {
    const ref = hashRef ?? page[3];
    return { url: `https://${page[1]}/${page[2]}.git`, ...(ref ? { ref } : {}), label: `${page[1]}/${page[2]}` };
  }
  if (/^(https:\/\/|git@)\S+\.git$/.test(spec)) {
    const label = spec.replace(/^https:\/\//, '').replace(/^git@([^:]+):/, '$1/').replace(/\.git$/, '');
    return { url: spec, ...(hashRef ? { ref: hashRef } : {}), label };
  }
  return undefined;
}

/**
 * Clones the repository shallow into a fresh temporary directory: only the
 * one commit, so a repository with years of history costs no more than its
 * current files. Nothing is installed and nothing in it is run; the analysis
 * reads files, and dependency typings come from the npm registry.
 *
 * A commit SHA is fetched directly (GitHub and GitLab allow it); a branch or
 * tag is cloned with `--branch`. The caller must call `remove` when done,
 * also on failure.
 *
 * @throws When `git` is missing or the clone fails, with git's own message.
 */
export function cloneRemote(repository: RemoteRepository): { directory: string; commit: string; remove: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'ng-checkup-'));
  const remove = (): void => rmSync(directory, { recursive: true, force: true });
  // GIT_TERMINAL_PROMPT=0: a private repository fails at once instead of
  // waiting for a username on a terminal nobody is watching.
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  try {
    if (repository.ref && /^[0-9a-f]{7,40}$/i.test(repository.ref)) {
      git('init', '-q');
      git('remote', 'add', 'origin', repository.url);
      git('fetch', '-q', '--depth', '1', 'origin', repository.ref);
      git('checkout', '-q', 'FETCH_HEAD');
    } else {
      git('clone', '-q', '--depth', '1', ...(repository.ref ? ['--branch', repository.ref] : []), repository.url, '.');
    }
    return { directory, commit: git('rev-parse', 'HEAD'), remove };
  } catch (error) {
    remove();
    const stderr = (error as { stderr?: string }).stderr?.trim();
    if ((error as { code?: string }).code === 'ENOENT') throw new Error('git is not installed, and it is needed to check a remote repository');
    throw new Error(`could not clone ${repository.label}${repository.ref ? ` at ${repository.ref}` : ''}${stderr ? `: ${stderr.split('\n').pop()}` : ''}`);
  }
}
