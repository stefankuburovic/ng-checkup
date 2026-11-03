import { BASELINE_FILE } from './baseline.js';
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
export type CiChoice = 'auto' | 'github' | 'gitlab' | 'azure' | 'bitbucket' | 'none';

/** What `planInit` should do. */
export interface InitOptions {
  /** Defaults to `auto`: GitHub when `.github/` exists, GitLab when `.gitlab-ci.yml` does, Azure DevOps when `azure-pipelines.yml` does, Bitbucket when `bitbucket-pipelines.yml` does, else none. */
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
  /**
   * Serialised baseline of the code as it is now, computed by the caller
   * (the planner never analyses). Written when no baseline exists, and it
   * switches the CI step to `--fail-on regression`.
   */
  baseline?: string;
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

/** The npm package `init` adds; the binary it installs is still called `ng-checkup`, which is what `CHECKUP_SCRIPT` runs. */
const PACKAGE_NAME = 'ng-checkup-cli';

/** Report files the generated config writes locally and the CI step writes as artifacts. */
const LOCAL_REPORT = 'checkup.html';
const CI_REPORTS = ['checkup.md', 'checkup.html'];

/**
 * Plans what `ng-checkup init` and `ng add ng-checkup-cli` set up in a repository:
 *
 * 1. a `checkup` script in `package.json` (and `ng-checkup` in `devDependencies`),
 * 2. `ng-checkup.config.json` with the local report and an empty `ignore` list,
 * 3. the generated reports in `.gitignore`, when there is one,
 * 4. a CI step: a GitHub Actions workflow, or a GitLab CI file to `include`,
 * 5. a baseline of today's numbers, when the caller supplies one.
 *
 * With a baseline the CI step runs `--fail-on regression`: it fails only
 * when a number gets worse, so a ten-year-old codebase can adopt it on day
 * one instead of being red until every legacy finding is fixed. Without one
 * it falls back to `--fail-on poor`.
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
  // 1.6.1 renamed the npm package from ng-checkup to ng-checkup-cli; a project that already has the old one keeps it.
  const installed = ['ng-checkup', PACKAGE_NAME].some((name) => name in dependencies || name in devDependencies);
  if (addDependency && !installed) {
    packageJson['devDependencies'] = { ...devDependencies, [PACKAGE_NAME]: `^${options.version}` };
    packageChanged = true;
    summaryParts.push(`${PACKAGE_NAME} ^${options.version} in devDependencies`);
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

  // 5. The baseline (written before the CI step, which depends on it).
  const hasBaseline = files.exists(BASELINE_FILE);
  if (!hasBaseline && options.baseline !== undefined) {
    changes.push({ path: BASELINE_FILE, action: 'create', content: options.baseline, summary: "Today's numbers; CI fails only when one gets worse. Commit it" });
  }
  const failOn = hasBaseline || options.baseline !== undefined ? 'regression' : 'poor';

  // 4. CI.
  const ci = resolveCi(files, options.ci ?? 'auto');
  if (ci === 'github') {
    const path = '.github/workflows/ng-checkup.yml';
    if (files.exists(path)) {
      notes.push(`Kept the existing ${path}.`);
      if (failOn === 'regression' && (files.read(path) ?? '').includes('--fail-on poor')) notes.push(`${path} still runs --fail-on poor. With a baseline, --fail-on regression lets existing code pass and fails only when a number gets worse.`);
    } else changes.push({ path, action: 'create', content: githubWorkflow(packageManager, failOn), summary: 'Runs the checkup on every pull request and uploads the reports' });
  } else if (ci === 'gitlab') {
    const path = 'ng-checkup.gitlab-ci.yml';
    if (files.exists(path)) {
      notes.push(`Kept the existing ${path}.`);
      if (failOn === 'regression' && (files.read(path) ?? '').includes('--fail-on poor')) notes.push(`${path} still runs --fail-on poor. With a baseline, --fail-on regression lets existing code pass and fails only when a number gets worse.`);
    } else changes.push({ path, action: 'create', content: gitlabJob(failOn), summary: 'A GitLab CI job: Code Quality in merge requests, the reports as artifacts, an MR comment once NG_CHECKUP_TOKEN is set' });
    if (!(files.read('.gitlab-ci.yml') ?? '').includes(path)) {
      notes.push(`Add this to your .gitlab-ci.yml to run it:\n    include:\n      - local: ${path}`);
    }
  } else if (ci === 'azure') {
    const path = 'ng-checkup.azure-pipelines.yml';
    if (files.exists(path)) notes.push(`Kept the existing ${path}.`);
    else changes.push({ path, action: 'create', content: azurePipeline(packageManager, failOn), summary: 'An Azure Pipelines pipeline: runs on pull requests, SARIF for the Scans tab, the reports as artifacts' });
    notes.push(`Create a pipeline from ${path} in Azure DevOps (Pipelines > New pipeline > Existing Azure Pipelines YAML file), and add it as a build validation of the target branch's policy so it runs on every pull request.`);
  } else if (ci === 'bitbucket') {
    const path = 'bitbucket-pipelines.yml';
    if (files.exists(path)) {
      if (!(files.read(path) ?? '').includes('ng-checkup')) notes.push(`Bitbucket reads one pipelines file, so ${path} was left as it is. Add this step under pipelines > pull-requests:\n${bitbucketStep(packageManager, failOn).replace(/^/gm, '    ')}`);
      else notes.push(`Kept the existing ${path}.`);
    } else changes.push({ path, action: 'create', content: bitbucketPipelines(packageManager, failOn), summary: 'Bitbucket Pipelines: runs the checkup on every pull request and keeps the reports as artifacts' });
  } else if ((options.ci ?? 'auto') === 'auto') {
    notes.push('No .github/, .gitlab-ci.yml, azure-pipelines.yml or bitbucket-pipelines.yml found, so no CI step was added. Run with --ci github, gitlab, azure or bitbucket to add one.');
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
  if (files.exists('azure-pipelines.yml') || files.exists('.azure-pipelines')) return 'azure';
  if (files.exists('bitbucket-pipelines.yml')) return 'bitbucket';
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
  return 'npx ng-checkup-cli';
}

/** What the CI step fails on: a worse number against the baseline, or a poor area without one. */
export type CiFailOn = 'regression' | 'poor';

/** The CI invocation, keeping both report formats. */
function ciRun(manager: PackageManager, failOn: CiFailOn): string {
  return `${binCommand(manager)} --fail-on ${failOn} ${CI_REPORTS.map((report) => `--report ${report}`).join(' ')}`;
}

/** A GitHub Actions workflow for the repository's package manager. */
export function githubWorkflow(manager: PackageManager, failOn: CiFailOn = 'poor'): string {
  const pnpmSetup = manager === 'pnpm' ? '      - uses: pnpm/action-setup@v4\n' : '';
  return `# Added by ng-checkup init. Grades the Angular codebase on every pull request
# and fails the job ${failOn === 'regression' ? 'when a number gets worse than ng-checkup.baseline.json' : 'when an area turns poor'}. Reports: see the run's artifacts.
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
      - run: ${ciRun(manager, failOn)}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ng-checkup
          path: |
${CI_REPORTS.map((report) => `            ${report}`).join('\n')}
`;
}

/**
 * An Azure Pipelines definition of its own, beside the repository's main
 * pipeline rather than inside it, since Azure runs any YAML file it is
 * pointed at and editing someone's main pipeline is not `init`'s to do.
 *
 * It installs, runs the checkup, and publishes the SARIF report as the
 * `CodeAnalysisLogs` artifact, the name Microsoft's SARIF SAST Scans Tab
 * extension reads, so findings show in the run's Scans tab when the
 * extension is installed and are a plain artifact when it is not. Azure has
 * no pull-request trigger in YAML for Azure Repos; it comes from a branch
 * policy, which the note `init` prints says how to add.
 */
export function azurePipeline(manager: PackageManager, failOn: CiFailOn = 'poor'): string {
  return `# Added by ng-checkup init. Grades the Angular codebase and fails the run
# ${failOn === 'regression' ? 'when a number gets worse than ng-checkup.baseline.json' : 'when an area turns poor'}. Create a pipeline from this file and
# add it as a build validation on the target branch to run it on pull requests.
trigger:
  branches:
    include: [main]
pr:
  branches:
    include: ['*']

pool:
  vmImage: ubuntu-latest

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '22.x'
${manager === 'pnpm' ? '  - script: corepack enable\n' : ''}  - script: ${installCommand(manager, true)}
    displayName: Install
  - script: ${ciRun(manager, failOn)} --report checkup.sarif
    displayName: ng-checkup
  - task: PublishBuildArtifacts@1
    condition: always()
    inputs:
      PathtoPublish: checkup.sarif
      ArtifactName: CodeAnalysisLogs
  - task: PublishBuildArtifacts@1
    condition: always()
    inputs:
      PathtoPublish: checkup.html
      ArtifactName: ng-checkup
`;
}

/** The Bitbucket Pipelines step: install, run, keep the reports. Indented for the `pull-requests` section. */
export function bitbucketStep(manager: PackageManager, failOn: CiFailOn = 'poor'): string {
  return `- step:
    name: ng-checkup
    image: node:22
    caches:
      - node
    script:
${manager === 'pnpm' ? '      - corepack enable\n' : ''}      - ${installCommand(manager, true)}
      - ${ciRun(manager, failOn)}
    artifacts:
${CI_REPORTS.map((report) => `      - ${report}`).join('\n')}`;
}

/**
 * A whole `bitbucket-pipelines.yml`, for a repository that has none.
 * Bitbucket reads that one file and has no include, so a repository that
 * already has one gets the step printed instead of a second file nobody
 * would run.
 */
export function bitbucketPipelines(manager: PackageManager, failOn: CiFailOn = 'poor'): string {
  const step = bitbucketStep(manager, failOn).replace(/^/gm, '      ');
  return `# Added by ng-checkup init. Grades the Angular codebase on every pull request
# and fails the step ${failOn === 'regression' ? 'when a number gets worse than ng-checkup.baseline.json' : 'when an area turns poor'}. Reports: the step's artifacts.
pipelines:
  pull-requests:
    '**':
${step}
  branches:
    main:
${step}
`;
}

/**
 * The GitLab job `init` writes: an `include` of the ng-checkup template at
 * the `v1` tag, plus the one setting `init` decides, `NG_CHECKUP_FAIL_ON`.
 *
 * The template (`gitlab/ng-checkup.yml`) runs the release it names with
 * `npx`, needs no install step, and brings the merge request integration:
 * the Code Quality widget, the artifacts and, once `NG_CHECKUP_TOKEN` is set,
 * one comment per merge request. Including it rather than copying it means a
 * repository gets fixes by the tag moving, not by re-running `init`. A GitLab
 * that cannot reach GitHub copies the template instead, which its header
 * explains.
 */
export function gitlabJob(failOn: CiFailOn = 'poor'): string {
  return `# Added by ng-checkup init. Include it from .gitlab-ci.yml:
#   include:
#     - local: ng-checkup.gitlab-ci.yml
#
# It adds the ng-checkup job: findings in the merge request's Code Quality
# widget, the reports as artifacts, and one merge request comment once
# NG_CHECKUP_TOKEN is set (a project access token with the api scope, as a
# masked CI/CD variable). Every option is described in the included file.
include:
  - remote: ${GITLAB_TEMPLATE_URL}

ng-checkup:
  variables:
    NG_CHECKUP_FAIL_ON: ${failOn}
`;
}

/** Where `include: remote:` finds the GitLab template: the moving `v1` tag, so fixes arrive without re-running `init`. */
export const GITLAB_TEMPLATE_URL = 'https://raw.githubusercontent.com/stefankuburovic/ng-checkup/v1/gitlab/ng-checkup.yml';

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
