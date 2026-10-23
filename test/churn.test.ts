import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readChurn } from '../src/churn.js';
import { runCheckup } from '../src/index.js';
import { removeTemp, writeTemp } from './helpers.js';

/** A git repository in a temp folder, with `commits` commits that each touch the given files. */
function repository(files: Record<string, string>, commits: Array<string[]>): string {
  const root = writeTemp(files);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  commits.forEach((touched, index) => {
    for (const path of touched) writeFileSync(join(root, path), `${files[path]}\n// change ${index}\n`);
    git('commit', '-q', '-am', `change ${index}`);
  });
  return root;
}

describe('hotspots from git history', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) removeTemp(root);
    root = undefined;
  });

  it('counts commits per file, relative to the analysed root', () => {
    root = repository({ 'src/a.ts': 'export const a = 1;', 'src/b.ts': 'export const b = 1;' }, [['src/a.ts'], ['src/a.ts', 'src/b.ts'], ['src/a.ts']]);
    const churn = readChurn(root);
    expect(typeof churn).toBe('object');
    if (typeof churn !== 'object') return;
    expect(churn.files.get('src/a.ts')).toBe(4);
    expect(churn.files.get('src/b.ts')).toBe(2);
    expect(churn.commits).toBe(4);
  });

  it('names a large file changed often as a hotspot, and a large file nobody touches not', async () => {
    const big = Array.from({ length: 320 }, (_, index) => `export const value${index} = ${index};`).join('\n');
    root = repository({ 'package.json': '{"name":"app","dependencies":{"@angular/core":"^22.0.0"}}', 'src/busy.ts': big, 'src/quiet.ts': big }, Array.from({ length: 11 }, () => ['src/busy.ts']));
    const report = await runCheckup(root, { offline: true });
    const architecture = report.checks.find((check) => check.id === 'architecture');
    const hotspot = architecture?.findings.find((finding) => finding.message.startsWith('Hotspots'));
    expect(hotspot?.message).toBe('Hotspots: large files changed most often');
    expect(hotspot?.files).toEqual([{ path: 'src/busy.ts' }]);
    expect(architecture?.metrics.find((metric) => metric.label === 'Hotspots')).toEqual({ label: 'Hotspots', value: '1', hint: 'from 12 commits in the last year' });
  });

  it('says why there is no history outside git', async () => {
    root = writeTemp({ 'src/a.ts': 'export const a = 1;' });
    expect(readChurn(root)).toBe('not a git repository');
  });
});
