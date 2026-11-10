import type { CheckResult, Finding, Grade } from '../types.js';
import { majorOf, type TargetInfo, type WorkspaceInfo } from '../workspace.js';
import { plural, type AnalysisContext } from './context.js';

/**
 * Packages whose presence is a finding of its own, with what replaced them.
 * `runtime` entries ship to users (a dead UI library), the others are tooling.
 * The difference decides the grade: dead runtime code is a liability, dead
 * tooling is friction.
 */
export const END_OF_LIFE_PACKAGES: Array<{ name: string; runtime: boolean; note: string }> = [
  { name: '@angular/http', runtime: true, note: 'Removed in Angular 8. Replaced by `HttpClient` from `@angular/common/http`.' },
  { name: '@angular/flex-layout', runtime: true, note: 'No longer maintained since Angular 15. Replaced by CSS flexbox/grid or a layout utility library.' },
  { name: 'protractor', runtime: false, note: 'End of life since 2023. Replaced by Playwright or Cypress.' },
  { name: 'tslint', runtime: false, note: 'Deprecated since 2019. Replaced by ESLint with `angular-eslint`.' },
  { name: 'codelyzer', runtime: false, note: 'A set of TSLint rules, so it died with TSLint. Replaced by `angular-eslint`.' },
  { name: 'node-sass', runtime: false, note: 'Deprecated. Replaced by `sass` (Dart Sass), which the Angular CLI already uses.' },
];

/**
 * `@angular/*` packages that do not follow the framework's version numbers, so
 * a different major is not a half-finished upgrade. AngularFire has its own
 * release line, and flex-layout is reported as end of life instead.
 */
const OWN_VERSIONING = new Set(['@angular/fire', '@angular/flex-layout']);

/** Builders that compile with webpack, which the esbuild `application` builder replaced as the default in v17. */
const WEBPACK_BUILDERS = new Set(['@angular-devkit/build-angular:browser', '@nx/angular:webpack-browser', '@angular-builders/custom-webpack:browser']);

/**
 * Where the codebase stands against the newest Angular release, and whether
 * its toolchain is current.
 *
 * Graded on the support window: Angular releases a major roughly every six
 * months and supports each for 18 (6 active, 12 LTS), so the newest three
 * majors are supported and anything older gets no security fixes. `ng update`
 * moves one major at a time, so the gap is also the number of upgrade steps.
 */
export function versionCheck(context: AnalysisContext): CheckResult {
  const { workspace, latestAngular } = context;
  const current = workspace.angular.major;
  const findings: Finding[] = [];
  const latestLabel = latestAngular.source === 'registry' ? 'npm registry' : 'offline, bundled estimate';

  if (current === undefined) {
    return {
      id: 'version',
      title: 'Angular version & tooling',
      grade: 'info',
      summary: workspace.nestedWorkspaces
        ? `No Angular workspace at the root; ${plural(workspace.nestedWorkspaces.length, 'subfolder')} ${workspace.nestedWorkspaces.length === 1 ? 'has' : 'have'} one: ${workspace.nestedWorkspaces.map((folder) => `\`${folder}\``).join(', ')}. Run ng-checkup on one of them (\`npx ng-checkup-cli ${workspace.nestedWorkspaces[0]}\`).`
        : context.angularJs.version || context.angularJs.files.length > 0
          ? context.angularJs.files.some((file) => file.primo?.viewCustom)
            ? 'No `@angular/core`: a Primo VE customization package, on AngularJS (see Primo NDE migration).'
            : 'No `@angular/core` yet: the app runs on AngularJS (see AngularJS migration).'
          : 'No `@angular/core` dependency found in package.json.',
      metrics: [{ label: 'Latest Angular', value: latestAngular.major, hint: latestLabel }],
      findings: [],
    };
  }

  const gap = Math.max(0, latestAngular.major - current);
  const versionLabel = workspace.angular.installed ?? workspace.angular.declared ?? String(current);
  if (gap >= 3) {
    findings.push({
      severity: 'high',
      message: `Angular ${current} is ${gap} majors behind ${latestAngular.major} and out of support`,
      detail: `Angular supports each major for 18 months, so only the newest three get fixes; ${current} receives no security patches. \`ng update\` moves one major at a time, which makes this ${plural(gap, 'sequential upgrade step')}, each with its own migrations to review.`,
    });
  } else if (gap === 2) {
    findings.push({
      severity: 'medium',
      message: `Angular ${current} is two majors behind and in its last months of LTS`,
      detail: `Support for ${current} ends when Angular ${latestAngular.major + 1} ships, roughly six months after ${latestAngular.major}. Two \`ng update\` steps bring it current.`,
    });
  } else if (gap === 1) {
    findings.push({ severity: 'low', message: `One major behind (${current} → ${latestAngular.major})`, detail: 'Supported, but the next release will make it two.' });
  }

  const mismatched = Object.keys(workspace.dependencies)
    .filter((name) => name.startsWith('@angular/') && !OWN_VERSIONING.has(name))
    .map((name) => ({ name, major: majorOf(workspace.versions[name] ?? workspace.dependencies[name]) }))
    .filter((entry) => entry.major !== undefined && entry.major !== current);
  if (mismatched.length > 0) {
    findings.push({
      severity: 'medium',
      message: `${plural(mismatched.length, 'Angular package')} on a different major than @angular/core ${current}`,
      detail: `${mismatched.map((entry) => `${entry.name} ${entry.major}`).join(', ')}. Angular packages are released in lockstep and only tested against the same major; a mixed set is usually a half-finished upgrade.`,
    });
  }

  // Per project, and only when the project has no esbuild build at all: a
  // workspace may keep an extra webpack target on purpose (SCION keeps
  // `build-basehref-webpack` to test that setup), which is not an unfinished migration.
  const esbuildProjects = new Set(workspace.targets.filter((target) => /:(application|browser-esbuild)$/.test(target.builder)).map((target) => target.project));
  const webpackProjects = [...new Set(workspace.targets.filter((target) => WEBPACK_BUILDERS.has(target.builder) && !esbuildProjects.has(target.project)).map((target) => target.project))];
  if (webpackProjects.length > 0) {
    findings.push({
      severity: 'medium',
      message: `${plural(webpackProjects.length, 'project')} still built with the webpack builder`,
      detail: `The esbuild-based \`application\` builder has been the default since Angular 17 and builds several times faster. \`ng update @angular/cli --name use-application-builder\` migrates the configuration. Projects: ${webpackProjects.join(', ')}.`,
    });
  }

  const endOfLife = END_OF_LIFE_PACKAGES.filter((entry) => entry.name in workspace.dependencies);
  for (const entry of endOfLife) {
    findings.push({ severity: entry.runtime ? 'high' : 'medium', message: `\`${entry.name}\` is end of life`, detail: entry.note });
  }

  const production = productionBuildIssues(workspace);
  for (const issue of PRODUCTION_ISSUES) {
    const hits = production.filter((entry) => entry.issue === issue.id);
    if (hits.length === 0) continue;
    const files = [...new Set(hits.map((entry) => entry.file))];
    findings.push({
      severity: issue.severity,
      message: `${issue.message}${hits.length > 1 || workspace.projects.length > 1 ? ` (${hits.map((entry) => entry.project).join(', ')})` : ''}`,
      detail: issue.detail,
      files: files.map((path) => ({ path })),
    });
  }
  const duplicates = context.duplicatePackages;
  if (duplicates && duplicates.packages.length > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(duplicates.packages.length, 'package')} installed in more than one major: ${duplicates.packages.map((entry) => `\`${entry.name}\` ${entry.versions.join(' and ')}`).join(', ')}`,
      detail: `Two majors of \`rxjs\` or an Angular package mean two copies in the bundle when both reach the browser, and \`instanceof\` or dependency injection that fails between them: an \`Observable\` of one is not one of the other. Usually a library pins the older major; \`npm ls ${duplicates.packages[0]!.name}\` shows which, and an update of that library or an \`overrides\` entry removes it. A copy only a build tool uses never reaches the browser${duplicates.file === 'package-lock.json' ? ', and those are left out here' : ', which this lockfile cannot tell apart'}.`,
      files: [{ path: duplicates.file }],
    });
  }

  const grade: Grade =
    gap >= 3 || endOfLife.some((entry) => entry.runtime) ? 'poor' : gap === 2 || mismatched.length > 0 || webpackProjects.length > 0 || endOfLife.length > 0 ? 'fair' : 'good';
  const usesApplicationBuilder = workspace.targets.some((target) => /:(application|browser-esbuild)$/.test(target.builder));

  return {
    id: 'version',
    title: 'Angular version & tooling',
    grade,
    summary: gap === 0 ? `On the latest major, Angular ${versionLabel}.` : `Angular ${versionLabel}, ${plural(gap, 'major')} behind ${latestAngular.major}.`,
    metrics: [
      { label: 'Installed', value: versionLabel, hint: workspace.angular.source ?? 'package.json range' },
      { label: 'Latest', value: latestAngular.major, hint: latestLabel },
      { label: 'Majors behind', value: gap },
      { label: 'Build system', value: webpackProjects.length > 0 ? 'webpack' : usesApplicationBuilder ? 'esbuild' : 'unknown' },
    ],
    findings,
    measures: [
      { id: 'end-of-life-packages', label: 'End-of-life packages', value: endOfLife.length },
      { id: 'webpack-builders', label: 'Projects on the webpack builder', value: webpackProjects.length },
      { id: 'mismatched-angular-packages', label: 'Angular packages on another major', value: mismatched.length },
      ...(production.length > 0 || hasProductionBuild(workspace) ? [{ id: 'production-build-issues', label: 'Production build settings that cost users', value: production.length }] : []),
      ...(duplicates ? [{ id: 'duplicate-packages', label: 'Packages installed in more than one major', value: duplicates.packages.length }] : []),
    ],
  };
}

/** What each production-build issue says. Severity follows what users pay: a slower app is medium, the rest low. */
const PRODUCTION_ISSUES: Array<{ id: string; severity: 'medium' | 'low'; message: string; detail: string }> = [
  {
    id: 'optimization',
    severity: 'medium',
    message: 'Production build without optimization',
    detail: '`optimization: false` in the production configuration ships unminified scripts and styles with dead code left in, often several times the size. Remove the setting, or set it to true.',
  },
  {
    id: 'aot',
    severity: 'medium',
    message: 'Production build without ahead-of-time compilation',
    detail: '`aot: false` ships the Angular compiler and compiles every template in the browser at startup. AOT has been the default since Angular 9; remove the setting.',
  },
  {
    id: 'build-optimizer',
    severity: 'low',
    message: 'Production build with the build optimizer off',
    detail: '`buildOptimizer: false` on the webpack builder leaves Angular decorators and dead code in the bundle. Remove the setting; the esbuild `application` builder does this by itself.',
  },
  {
    id: 'source-maps',
    severity: 'low',
    message: 'Production build publishes its source maps',
    detail: 'With `sourceMap: true` the browser downloads the original TypeScript, comments included, for anyone to read in the developer tools. If an error tracker needs the maps, `"sourceMap": { "scripts": true, "hidden": true }` writes them without the reference in the bundle, so they can be uploaded and kept off the server.',
  },
  {
    id: 'budgets',
    severity: 'low',
    message: 'Production build without budgets',
    detail: 'Without `budgets` the build never warns when the initial bundle grows. New projects get an `initial` budget of 500 kB to warn and 1 MB to fail; set one near today\'s size so the next large dependency is noticed in review.',
  },
  {
    id: 'output-hashing',
    severity: 'low',
    message: 'Production build without hashed file names',
    detail: 'Without `outputHashing: "all"` the file names stay the same between releases, so a browser or CDN can keep serving yesterday\'s `main.js` with today\'s `index.html`. New projects set it in the production configuration.',
  },
];

/** The builders of an application build, CLI and Nx, webpack and esbuild. Libraries build with ng-packagr and are left out. */
const APPLICATION_BUILDER = /:(application|browser|browser-esbuild|webpack-browser)$/;

/** The `build` targets of applications that declare a production configuration. Without one, what `ng build` uses cannot be told. */
function productionTargets(workspace: WorkspaceInfo): Array<{ target: TargetInfo; settings: Record<string, unknown> }> {
  return workspace.targets
    .filter((target) => target.target === 'build' && APPLICATION_BUILDER.test(target.builder))
    .flatMap((target) => {
      const production = target.configurations?.['production'];
      if (typeof production !== 'object' || production === null || Array.isArray(production)) return [];
      return [{ target, settings: { ...target.options, ...(production as Record<string, unknown>) } }];
    });
}

/** True when some application declares a production build, so the measure means something. */
function hasProductionBuild(workspace: WorkspaceInfo): boolean {
  return productionTargets(workspace).length > 0;
}

/**
 * Settings of the production configuration, laid over the target's options,
 * that cost the users of the app. Only what is written counts: a setting the
 * builder defaults is left alone, except `outputHashing`, which defaults to
 * `none` and so has to be written.
 */
export function productionBuildIssues(workspace: WorkspaceInfo): Array<{ issue: string; project: string; file: string }> {
  const issues: Array<{ issue: string; project: string; file: string }> = [];
  for (const { target, settings } of productionTargets(workspace)) {
    const file = `${workspace.subfolder ? `${workspace.subfolder}/` : ''}${target.configFile ?? 'angular.json'}`;
    const add = (issue: string): void => {
      issues.push({ issue, project: target.project, file });
    };
    const optimization = settings['optimization'];
    if (optimization === false || (isRecord(optimization) && optimization['scripts'] === false)) add('optimization');
    if (settings['aot'] === false) add('aot');
    if (settings['buildOptimizer'] === false && /webpack|:browser$/.test(target.builder)) add('build-optimizer');
    const sourceMap = settings['sourceMap'];
    if (sourceMap === true || (isRecord(sourceMap) && sourceMap['scripts'] !== false && sourceMap['hidden'] !== true)) add('source-maps');
    if (!Array.isArray(settings['budgets']) || settings['budgets'].length === 0) add('budgets');
    if (settings['outputHashing'] !== 'all' && settings['outputHashing'] !== 'bundles') add('output-hashing');
  }
  return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
