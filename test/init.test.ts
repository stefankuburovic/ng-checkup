import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { formatJsonLike, githubWorkflow, gitlabJob, planInit, type InitFileSystem } from '../src/init.js';

/** An in-memory repository: path to content. A key ending in `/` is an empty directory. */
function memory(files: Record<string, string>): InitFileSystem {
  return {
    read: (path) => files[path],
    exists: (path) => path in files || `${path}/` in files || Object.keys(files).some((key) => key.startsWith(`${path}/`)),
  };
}

const angularPackage = `{\n  "name": "app",\n  "scripts": {\n    "start": "ng serve"\n  },\n  "dependencies": {\n    "@angular/core": "^20.0.0"\n  }\n}\n`;

describe('planInit', () => {
  it('adds the script, the dev dependency, the config, the gitignore lines and a GitHub workflow', () => {
    const plan = planInit(memory({ 'package.json': angularPackage, 'angular.json': '{}', '.gitignore': 'node_modules\n', '.github/': '' }), { version: '0.2.0' });

    expect(plan.changes.map((change) => [change.action, change.path])).toEqual([
      ['update', 'package.json'],
      ['create', 'ng-checkup.config.json'],
      ['update', '.gitignore'],
      ['create', '.github/workflows/ng-checkup.yml'],
    ]);
    const packageJson = JSON.parse(plan.changes[0]!.content) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(packageJson.scripts).toEqual({ start: 'ng serve', checkup: 'ng-checkup' });
    expect(packageJson.devDependencies).toEqual({ 'ng-checkup': '^0.2.0' });
    expect(JSON.parse(plan.changes[1]!.content)).toEqual({ reports: ['checkup.html'], ignore: [] });
    expect(plan.changes[2]!.content).toBe('node_modules\n\n# ng-checkup reports\n/checkup.html\n/checkup.md\n');
    expect(plan.ci).toBe('github');
    expect(plan.nextSteps).toEqual(['npm install', 'npm run checkup']);
    expect(plan.notes).toEqual([]);
  });

  it('is idempotent: a second run on the result plans nothing', () => {
    const files: Record<string, string> = { 'package.json': angularPackage, 'angular.json': '{}', '.gitignore': 'node_modules\n', '.github/': '' };
    for (const change of planInit(memory(files), { version: '0.2.0' }).changes) files[change.path] = change.content;
    const second = planInit(memory(files), { version: '0.2.0' });
    expect(second.changes).toEqual([]);
    expect(second.notes).toEqual(['Kept the existing .github/workflows/ng-checkup.yml.']);
  });

  it('keeps a "checkup" script that runs something else, unless forced', () => {
    const custom = angularPackage.replace('"start": "ng serve"', '"start": "ng serve",\n    "checkup": "my-own-tool"');
    const kept = planInit(memory({ 'package.json': custom, 'angular.json': '{}' }), { version: '0.2.0', ci: 'none' });
    expect(JSON.parse(kept.changes[0]!.content).scripts.checkup).toBe('my-own-tool');
    expect(kept.notes[0]).toContain('Kept your existing "checkup" script (my-own-tool)');

    const forced = planInit(memory({ 'package.json': custom, 'angular.json': '{}' }), { version: '0.2.0', ci: 'none', force: true });
    expect(JSON.parse(forced.changes[0]!.content).scripts.checkup).toBe('ng-checkup');
  });

  it('leaves the dependency to ng add when told to', () => {
    const plan = planInit(memory({ 'package.json': angularPackage, 'angular.json': '{}' }), { version: '0.2.0', addDependency: false, ci: 'none' });
    expect(JSON.parse(plan.changes[0]!.content).devDependencies).toBeUndefined();
    expect(plan.nextSteps).toEqual(['npm run checkup']);
  });

  it('writes a separate GitLab file and explains the include, without touching .gitlab-ci.yml', () => {
    const plan = planInit(memory({ 'package.json': angularPackage, 'angular.json': '{}', '.gitlab-ci.yml': 'stages: [build]\n' }), { version: '0.2.0' });
    expect(plan.ci).toBe('gitlab');
    expect(plan.changes.map((change) => change.path)).toContain('ng-checkup.gitlab-ci.yml');
    expect(plan.changes.map((change) => change.path)).not.toContain('.gitlab-ci.yml');
    expect(plan.notes.join('\n')).toContain('- local: ng-checkup.gitlab-ci.yml');
  });

  it('uses the package manager the lockfile names', () => {
    const pnpm = planInit(memory({ 'package.json': angularPackage, 'angular.json': '{}', 'pnpm-lock.yaml': '', '.github/': '' }), { version: '0.2.0' });
    expect(pnpm.packageManager).toBe('pnpm');
    expect(pnpm.nextSteps).toEqual(['pnpm install', 'pnpm checkup']);
    expect(pnpm.changes.find((change) => change.path.endsWith('.yml'))?.content).toContain('pnpm/action-setup@v4');
  });

  it('says so when no CI exists and when the repository is not Angular, but still plans the rest', () => {
    const plan = planInit(memory({ 'package.json': '{"name":"x"}' }), { version: '0.2.0' });
    expect(plan.ci).toBe('none');
    expect(plan.notes.join('\n')).toContain('does not look like an Angular workspace');
    expect(plan.notes.join('\n')).toContain('--ci github');
    expect(plan.changes.map((change) => change.path)).toEqual(['package.json', 'ng-checkup.config.json']);
  });

  it('refuses to run without a usable package.json', () => {
    expect(() => planInit(memory({}), { version: '0.2.0' })).toThrow('No package.json here');
    expect(() => planInit(memory({ 'package.json': '{ nope' }), { version: '0.2.0' })).toThrow('package.json is not valid JSON');
  });
});

describe('formatJsonLike', () => {
  it('keeps the original indentation, line endings and final newline', () => {
    expect(formatJsonLike('{\n    "a": 1\n}\n', { a: 1, b: 2 })).toBe('{\n    "a": 1,\n    "b": 2\n}\n');
    expect(formatJsonLike('{\r\n\t"a": 1\r\n}', { a: 1 })).toBe('{\r\n\t"a": 1\r\n}');
  });
});

describe('CI templates', () => {
  it('fail on a poor area and keep both reports', () => {
    expect(githubWorkflow('npm')).toContain('npx ng-checkup --fail-on poor --report checkup.md --report checkup.html');
    expect(githubWorkflow('yarn')).toContain('yarn ng-checkup --fail-on poor');
  });

  it('include the GitLab template at the v1 tag and set only fail-on', () => {
    const job = gitlabJob('regression');
    expect(job).toContain('- remote: https://raw.githubusercontent.com/stefankuburovic/ng-checkup/v1/gitlab/ng-checkup.yml');
    expect(job).toMatch(/ng-checkup:\n {2}variables:\n {4}NG_CHECKUP_FAIL_ON: regression\n$/);
  });

  it('ship a GitLab template that runs this very release, with Code Quality and the comment', () => {
    const template = readFileSync(new URL('../gitlab/ng-checkup.yml', import.meta.url), 'utf8');
    const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    // A release moves v1 to a commit whose template must run that same release.
    expect(template).toContain(`NG_CHECKUP_VERSION: ${version}`);
    expect(template).toContain('codequality: ng-checkup/ng-checkup.codequality.json');
    expect(template).toContain('--report "$out/ng-checkup.comment.md"');
    expect(template).toContain('startsWith("<!-- ng-checkup -->")');
  });
});

describe('the ng add schematic', () => {
  const require = createRequire(import.meta.url);
  const { ngAdd } = require('../schematics/ng-add/index.cjs') as { ngAdd: (options: object) => (tree: unknown, context: unknown) => Promise<unknown> };

  /** The slice of the Angular devkit Tree the schematic uses. */
  function fakeTree(files: Record<string, string>) {
    return {
      files,
      read: (path: string) => (path.slice(1) in files ? Buffer.from(files[path.slice(1)]!) : null),
      exists: (path: string) => path.slice(1) in files,
      getDir: (path: string) => {
        const prefix = `${path.slice(1)}/`;
        const inside = Object.keys(files).filter((key) => key.startsWith(prefix));
        return { subfiles: inside.filter((key) => !key.slice(prefix.length).includes('/')), subdirs: inside.filter((key) => key.slice(prefix.length).includes('/')) };
      },
      create: (path: string, content: string) => {
        if (path.slice(1) in files) throw new Error(`${path} already exists`);
        files[path.slice(1)] = content;
      },
      overwrite: (path: string, content: string) => {
        files[path.slice(1)] = content;
      },
    };
  }

  it('applies the init plan through the tree, without adding the dependency the CLI already saved', async () => {
    const tree = fakeTree({ 'package.json': angularPackage, 'angular.json': '{}', '.github/dependabot.yml': '' });
    const logged: string[] = [];
    const logger = { info: (line: string) => logged.push(line), warn: (line: string) => logged.push(`warn: ${line}`) };
    await ngAdd({ ci: 'auto' })(tree, { logger });

    expect(JSON.parse(tree.files['package.json']!).scripts.checkup).toBe('ng-checkup');
    expect(JSON.parse(tree.files['package.json']!).devDependencies).toBeUndefined();
    expect(tree.files['ng-checkup.config.json']).toBeDefined();
    expect(tree.files['.github/workflows/ng-checkup.yml']).toContain('name: ng-checkup');
    expect(logged.at(-1)).toBe('Run the checkup with: npm run checkup');
  });
});
