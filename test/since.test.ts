import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCheckup, SinceError } from '../src/index.js';
import { narrowToChanged } from '../src/since.js';
import type { CheckResult } from '../src/types.js';
import { removeTemp, writeTemp } from './helpers.js';

/** Runs git in `root` with an identity, so a commit works on any machine. */
function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { stdio: 'ignore' });
}

/** A component that subscribes with nothing to end it, the low finding the test narrows. */
const leaking = (name: string) => `import { Component } from '@angular/core';\n@Component({ selector: 'app-${name}', template: '' })\nexport class ${name}Component {\n  ngOnInit() { this.store.list$.subscribe(); }\n}\n`;

describe('--since', () => {
  it('keeps only the findings in files changed since the merge base, and leaves grades and measures alone', async () => {
    const root = writeTemp({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^20.0.0' } }),
      'src/a.component.ts': leaking('A'),
      'src/b.component.ts': leaking('B'),
    });
    try {
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'add', '.');
      git(root, 'commit', '-q', '-m', 'base');
      git(root, 'checkout', '-q', '-b', 'feature');
      // One committed change and one untracked file: both belong to the branch.
      writeFileSync(join(root, 'src/b.component.ts'), leaking('B') + '// touched\n');
      git(root, 'commit', '-q', '-am', 'touch b');
      writeFileSync(join(root, 'src/c.component.ts'), leaking('C'));

      const full = await runCheckup(root, { offline: true });
      const narrowed = await runCheckup(root, { offline: true, since: 'main' });
      const findingOf = (checks: CheckResult[]) => checks.find((check) => check.id === 'components')?.findings.find((finding) => finding.message.includes('nothing ever ends'));

      expect(findingOf(full.checks)?.files?.map((file) => file.path)).toEqual(['src/a.component.ts', 'src/b.component.ts', 'src/c.component.ts']);
      expect(findingOf(narrowed.checks)?.files?.map((file) => file.path)).toEqual(['src/b.component.ts', 'src/c.component.ts']);
      expect(narrowed.since).toMatchObject({ ref: 'main', changedFiles: 2 });
      expect(narrowed.checks.map((check) => check.grade)).toEqual(full.checks.map((check) => check.grade));
      expect(narrowed.checks.map((check) => check.measures)).toEqual(full.checks.map((check) => check.measures));

      await expect(runCheckup(root, { offline: true, since: 'no-such-branch' })).rejects.toBeInstanceOf(SinceError);
    } finally {
      removeTemp(root);
    }
  });

  it('drops a finding with no files left and caps the examples again', () => {
    const checks: CheckResult[] = [
      {
        id: 'x',
        title: 'X',
        grade: 'fair',
        summary: '',
        metrics: [],
        findings: [
          { severity: 'high', message: 'repository-wide' },
          { severity: 'low', message: 'elsewhere', files: [{ path: 'a.ts' }], count: 1 },
          { severity: 'low', message: 'here', files: [{ path: 'b.ts', line: 1 }, { path: 'c.ts' }, { path: 'd.ts' }], count: 9 },
        ],
      },
    ];
    const [narrowed] = narrowToChanged(checks, new Set(['b.ts', 'c.ts', 'd.ts']), 2);
    expect(narrowed?.findings).toEqual([{ severity: 'low', message: 'here', files: [{ path: 'b.ts', line: 1 }, { path: 'c.ts' }], count: 3 }]);
    expect(checks[0]?.findings).toHaveLength(3);
  });
});
