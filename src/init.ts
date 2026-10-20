import { CONFIG_FILE } from './config.js';

/**
 * The two reads `planInit` needs. `ng-checkup init` backs it with `node:fs`,
 * `ng add` with the schematic's virtual tree, and tests with a plain object,
 * which is why the planner never touches the disk itself.
 */
export interface InitFileSystem {
  /** File content, or undefined when the path is missing. Paths are root-relative with `/`. */
  read(path: string): string | undefined;
  /** True for an existing file or directory. */
  exists(path: string): boolean;
}

/** Where the CI step goes. `auto` picks from what the repository already has. */
export type CiChoice = 'auto' | 'github' | 'gitlab' | 'none';

/** What `planInit` should do. */
export interface InitOptions {
  /** Defaults to `auto`: GitHub when `.github/` exists, GitLab when `.gitlab-ci.yml` does, else none. */
  ci?: CiChoice;
  /**
   * Add `ng-checkup` to `devDependencies`. Defaults to true. `ng add` passes
   * false because the Angular CLI has already installed and saved it.
   */
  addDependency?: boolean;
  /** The version to pin, normally this package's own. */
  version: string;
  /** Replace an existing `checkup` script that runs something else. */
  force?: boolean;
}

/** One file to write. Content is the whole new file. */
export interface InitChange {
  path: string;
  action: 'create' | 'update';
  content: string;
  /** One line for the user: what this change does. */
  summary: string;
}

/** Everything `init` would do, and what the user has to do afterwards. */
export interface InitPlan {
  changes: InitChange[];
  /** Things left alone or left to the user, one line each. */
  notes: string[];
  /** Commands the user runs next, in order. */
  nextSteps: string[];
  ci: Exclude<CiChoice, 'auto'>;
  packageManager: PackageManager;
}

/** The package managers whose lockfiles `init` recognises. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn';

/** The script `init` adds. Reports come from the config file, so the script stays this short. */
const CHECKUP_SCRIPT = 'ng-checkup';

/** Report files the generated config writes locally and the CI step writes as artifacts. */
const LOCAL_REPORT = 'checkup.html';
const CI_REPORTS = ['checkup.md', 'checkup.html'];

/**
 * Plans what `ng-checkup init` and `ng add ng-checkup` set up in a repository:
 *
 * 1. a `checkup` script in `package.json` (and `ng-checkup` in `devDependencies`),
 * 2. `ng-checkup.config.json` with the local report and an empty `ignore` list,
 * 3. the generated reports in `.gitignore`, when there is one,
 * 4. a CI step: a GitHub Actions workflow, or a GitLab CI file to `include`.
 *
 * Idempotent: on a repository that already has all of it, the plan is empty.
 * It never overwrites a file the user wrote: an existing workflow, config or
 * different `checkup` script is kept and reported in `notes` instead
 * (`force` replaces the script only). It does not edit `.gitlab-ci.yml`
 * either, since merging into someone's pipeline YAML is where a tool does
 * damage; it writes a separate file and says which `include` to add.
 *
 * @throws When there is no `package.json` or it is not valid JSON. Both mean
 *   this is not the root of a Node project, and writing anything would be wrong.
 */
export function planInit(files: InitFileSystem, options: InitOptions): InitPlan {
  const changes: InitChange[] = [];
  const notes: string[] = [];
  const packageManager = detectPackageManager(files);

  const packageText = files.read('package.json');
  if (packageText === undefined) throw new Error('No package.json here. Run ng-checkup init in the root of your Angular project.');
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(packageText) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const dependencies = asRecord(packageJson['dependencies']);
  const devDependencies = asRecord(packageJson['devDependencies']);
  if (!files.exists('angular.json') && !files.exists('nx.json') && !('@angular/core' in dependencies) && !('@angular/core' in devDependencies)) {
    notes.push('This does not look like an Angular workspace (no angular.json, nx.json or @angular/core). The checkup will still run, but most areas will be "info".');
  }

  // 1. package.json: the script and the dev dependency.
  let packageChanged = false;
  const summaryParts: string[] = [];
  const scripts = { ...asRecord(packageJson['scripts']) };
  const existingScript = scripts['checkup'];
  if (existingScript === undefined || (existingScript !== CHECKUP_SCRIPT && options.force)) {
    scripts['checkup'] = CHECKUP_SCRIPT;
    packageJson['scripts'] = scripts;
    packageChanged = true;
    summaryParts.push(`"checkup" script`);
  } else if (existingScript !== CHECKUP_SCRIPT) {
    notes.push(`Kept your existing "checkup" script (${String(existingScript)}). Run with --force to replace it with "${CHECKUP_SCRIPT}".`);
  }
  const addDependency = options.addDependency ?? true;
  if (addDependency && !('ng-checkup' in dependencies) && !('ng-checkup' in devDependencies)) {
    packageJson['devDependencies'] = { ...devDependencies, 'ng-checkup': `^${options.version}` };
    packageChanged = true;
    summaryParts.push(`ng-checkup ^${options.version} in devDependencies`);
  }
  if (packageChanged) {
    changes.push({ path: 'package.json', action: 'update', content: formatJsonLike(packageText, packageJson), summary: `Adds ${summaryParts.join(' and ')}` });
  }

  // 2. The config file.
  if (!files.exists(CONFIG_FILE)) {
    changes.push({
      path: CONFIG_FILE,
      action: 'create',
      content: `${JSON.stringify({ reports: [LOCAL_REPORT], ignore: [] }, null, 2)}\n`,
      summary: `Writes ${LOCAL_REPORT} on every run; add paths to "ignore" to leave them out`,
    });
  }

  // 3. .gitignore, only when the repository has one.
  const gitignore = files.read('.gitignore');
  if (gitignore !== undefined) {
    const lines = new Set(gitignore.split(/\r?\n/).map((line) => line.trim()));
    const missing = [...new Set([LOCAL_REPORT, ...CI_REPORTS])].map((report) => `/${report}`).filter((entry) => !lines.has(entry) && !lines.has(entry.slice(1)));
    if (missing.length > 0) {
      const separator = gitignore.length === 0 || gitignore.endsWith('\n') ? '' : '\n';
      changes.push({ path: '.gitignore', action: 'update', content: `${gitignore}${separator}\n# ng-checkup reports\n${missing.join('\n')}\n`, summary: 'Keeps the generated reports out of git' });
    }
  }

  // 4. CI.
  const ci = resolveCi(files, options.ci ?? 'auto');
  if (ci === 'github') {
    const path = '.github/workflows/ng-checkup.yml';
    if (files.exists(path)) notes.push(`Kept the existing ${path}.`);
    else changes.push({ path, action: 'create', content: githubWorkflow(packageManager), summary: 'Runs the checkup on every pull request and uploads the reports' });
  } else if (ci === 'gitlab') {
    const path = 'ng-checkup.gitlab-ci.yml';
    if (files.exists(path)) notes.push(`Kept the existing ${path}.`);
    else changes.push({ path, action: 'create', content: gitlabJob(packageManager), summary: 'A GitLab CI job that runs the checkup and keeps the reports as artifacts' });
    if (!(files.read('.gitlab-ci.yml') ?? '').includes(path)) {
      notes.push(`Add this to your .gitlab-ci.yml to run it:\n    include:\n      - local: ${path}`);
    }
  } else if ((options.ci ?? 'auto') === 'auto') {
    notes.push('No .github/ or .gitlab-ci.yml found, so no CI step was added. Run with --ci github or --ci gitlab to add one.');
  }

  const nextSteps: string[] = [];
  if (packageChanged && addDependency) nextSteps.push(installCommand(packageManager, false));
  nextSteps.push(runScriptCommand(packageManager));
  return { changes, notes, nextSteps, ci, packageManager };
}

/** The CI to set up for `auto`: whatever the repository already uses. */
function resolveCi(files: InitFileSystem, choice: CiChoice): Exclude<CiChoice, 'auto'> {
  if (choice !== 'auto') return choice;
  if (files.exists('.github')) return 'github';
  if (files.exists('.gitlab-ci.yml')) return 'gitlab';
  return 'none';
}

/** The package manager, from its lockfile. npm when there is none or only npm's. */
export function detectPackageManager(files: InitFileSystem): PackageManager {
  if (files.exists('pnpm-lock.yaml')) return 'pnpm';
  if (files.exists('yarn.lock')) return 'yarn';
  return 'npm';
}

/** Install command; `frozen` is the CI form that refuses to change the lockfile. */
function installCommand(manager: PackageManager, frozen: boolean): string {
  if (manager === 'pnpm') return frozen ? 'pnpm install --frozen-lockfile' : 'pnpm install';
  if (manager === 'yarn') return frozen ? 'yarn install --frozen-lockfile' : 'yarn install';
  return frozen ? 'npm ci' : 'npm install';
}

/** How to run the `checkup` script. */
function runScriptCommand(manager: PackageManager): string {
  return manager === 'npm' ? 'npm run checkup' : `${manager} checkup`;
}

/** How CI runs the installed binary. */
function binCommand(manager: PackageManager): string {
  if (manager === 'pnpm') return 'pnpm exec ng-checkup';
  if (manager === 'yarn') return 'yarn ng-checkup';
  return 'npx ng-checkup';
}

/** The CI invocation: fail on a poor area, keep both report formats. */
function ciRun(manager: PackageManager): string {
  return `${binCommand(manager)} --fail-on poor ${CI_REPORTS.map((report) => `--report ${report}`).join(' ')}`;
}

/** A GitHub Actions workflow for the repository's package manager. */
export function githubWorkflow(manager: PackageManager): string {
  const pnpmSetup = manager === 'pnpm' ? '      - uses: pnpm/action-setup@v4\n' : '';
  return `# Added by ng-checkup init. Grades the Angular codebase on every pull request
# and fails the job when an area turns poor. Reports: see the run's artifacts.
name: ng-checkup

on:
  pull_request:
  push:
    branches: [main]

jobs:
  checkup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${pnpmSetup}      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: ${manager}
      - run: ${installCommand(manager, true)}
      - run: ${ciRun(manager)}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ng-checkup
          path: |
${CI_REPORTS.map((report) => `            ${report}`).join('\n')}
`;
}

/** A GitLab CI job file for the repository's package manager, meant to be `include`d. */
export function gitlabJob(manager: PackageManager): string {
  const corepack = manager === 'pnpm' ? '    - corepack enable\n' : '';
  return `# Added by ng-checkup init. Include it from .gitlab-ci.yml:
#   include:
#     - local: ng-checkup.gitlab-ci.yml
ng-checkup:
  image: node:22
  script:
${corepack}    - ${installCommand(manager, true)}
    - ${ciRun(manager)}
  artifacts:
    when: always
    expose_as: ng-checkup report
    paths:
${CI_REPORTS.map((report) => `      - ${report}`).join('\n')}
`;
}

/**
 * Serialises `value` with the indentation and final newline of `original`,
 * so `init` changes only the lines it means to and a `git diff` of
 * `package.json` shows exactly the added keys.
 */
export function formatJsonLike(original: string, value: unknown): string {
  const indent = /^[{[]\r?\n([ \t]+)/.exec(original)?.[1] ?? '  ';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const body = JSON.stringify(value, null, indent).replace(/\n/g, newline);
  return original.endsWith('\n') ? `${body}${newline}` : body;
}

/** Narrows an unknown JSON value to an object, treating anything else as empty. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
