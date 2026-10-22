import type { CheckResult, Finding, Grade } from '../types.js';
import { majorOf } from '../workspace.js';
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
      summary:
        context.angularJs.version || context.angularJs.files.length > 0
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
    ],
  };
}
