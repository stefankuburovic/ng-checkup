import type { AngularJsFileFacts, Registration } from '../angularjs.js';
import { viewRootOf } from '../primo.js';
import type { CheckResult, FileRef, Finding, Grade } from '../types.js';
import { applicationFiles, countCalls, filesImporting, formatCount, percent, plural, verb, type AnalysisContext } from './context.js';

/**
 * AngularJS packages with what replaces each in Angular. Every one of them is
 * a dependency the migration has to retire, and the replacement decides how
 * much of the code around it changes.
 */
export const ANGULARJS_PACKAGES: Array<{ name: string; replacement: string }> = [
  { name: 'angular-route', replacement: 'the Angular Router' },
  { name: 'angular-ui-router', replacement: '`@uirouter/angular` (with `@uirouter/angular-hybrid` during the migration) or the Angular Router' },
  { name: '@uirouter/angularjs', replacement: '`@uirouter/angular` (with `@uirouter/angular-hybrid` during the migration) or the Angular Router' },
  { name: 'angular-resource', replacement: '`HttpClient`' },
  { name: 'restangular', replacement: '`HttpClient`' },
  { name: 'angular-animate', replacement: 'CSS transitions, or `@angular/animations`' },
  { name: 'angular-sanitize', replacement: 'Angular\'s built-in sanitization' },
  { name: 'angular-cookies', replacement: 'a small cookie service, such as `ngx-cookie-service`' },
  { name: 'angular-messages', replacement: 'validation messages from reactive forms' },
  { name: 'angular-translate', replacement: '`@ngx-translate/core`, or `@angular/localize`' },
  { name: 'angular-gettext', replacement: '`@angular/localize`, or `@ngx-translate/core`' },
  { name: 'angular-material', replacement: '`@angular/material` (AngularJS Material is end of life since January 2022)' },
  { name: 'angular-ui-bootstrap', replacement: '`@ng-bootstrap/ng-bootstrap` or `ngx-bootstrap`' },
  { name: 'angular-strap', replacement: '`@ng-bootstrap/ng-bootstrap` or `ngx-bootstrap`' },
  { name: 'angular-ui-grid', replacement: 'AG Grid or the Angular Material table' },
  { name: 'ui-grid', replacement: 'AG Grid or the Angular Material table' },
  { name: 'angular-mocks', replacement: '`TestBed`' },
];

/** The registrations a migration moves, grouped the way the plan moves them. */
const UI_KINDS = new Set<Registration['kind']>(['component', 'directive', 'controller']);
const SERVICE_KINDS = new Set<Registration['kind']>(['service', 'factory', 'provider']);

/** Above this share of components already on Angular, a hybrid app is graded fair instead of poor. */
const MOSTLY_MIGRATED = 80;

/** What the AngularJS check and the migration plan both need, counted once. */
export interface AngularJsSummary {
  /** AngularJS code is present, or AngularJS is a dependency (see `hasAngularJs`). */
  present: boolean;
  /** AngularJS code exists, as opposed to leftover packages only. */
  hasCode: boolean;
  version?: string;
  versionSource?: string;
  /** How the two frameworks run together, undefined for an app without Angular. */
  hybrid?: 'UpgradeModule' | 'downgradeModule' | 'UpgradeAdapter';
  angularMajor?: number;
  /** Non-test files with AngularJS code. */
  files: AngularJsFileFacts[];
  registrations: Array<Registration & { path: string }>;
  components: number;
  directives: number;
  controllers: number;
  services: number;
  filters: number;
  /** Components, directives and controllers. */
  uiUnits: number;
  /** Angular components in the same codebase, which is what "migrated" is measured against. */
  angularComponents: number;
  angularServices: number;
  downgradedComponents: number;
  downgradedServices: number;
  upgradedComponents: number;
  upgradedServices: number;
  scopeFiles: AngularJsFileFacts[];
  scopeEvents: number;
  watchers: number;
  compiles: number;
  legacyDirectives: Array<{ path: string; line: number; keys: string[] }>;
  routes: number;
  /** Templates with AngularJS attributes. */
  templates: Array<{ path: string; controllers: number; includes: number }>;
  templateControllers: number;
  includes: number;
  /** AngularJS code files written in JavaScript. */
  javascriptFiles: number;
  packages: Array<{ name: string; replacement: string }>;
  bower: boolean;
}

/**
 * True when the repository has anything AngularJS: code, templates, or the
 * `angular` or `@angular/upgrade` package. The AngularJS check is only added
 * to a report when it is, since for every other Angular app it would be a
 * thirteenth line saying "not applicable".
 */
export function hasAngularJs(context: AnalysisContext): boolean {
  return summarizeAngularJs(context).present;
}

/**
 * Counts everything AngularJS in the context. Registrations whose call chain
 * does not start at `angular.module()` (`app.controller()` on a module
 * imported from another file) count only when the repository shows AngularJS
 * elsewhere, so a Vue app's `Vue.component('x', …)` never does.
 */
export function summarizeAngularJs(context: AnalysisContext): AngularJsSummary {
  const { angularJs, workspace } = context;
  const files = angularJs.files.filter((file) => !file.isSpec);
  const evidence =
    files.some((file) => file.moduleDefinitions.length > 0 || file.registrations.some((registration) => registration.rooted)) ||
    angularJs.version !== undefined ||
    angularJs.templates.some((template) => template.stats.apps > 0);
  // One registration per name and kind within a folder of the app: a concatenated bundle checked in
  // beside its sources (Primo packages ship `js/custom.js` built from the other files of `js/`)
  // registers everything a second time, and counting both doubled every number.
  const seen = new Set<string>();
  const registrations = files
    .flatMap((file) => file.registrations.filter((registration) => !registration.downgraded && (registration.rooted || evidence)).map((registration) => ({ ...registration, path: file.path })))
    .filter((registration) => {
      const key = `${viewRootOf(registration.path)}|${registration.kind}|${registration.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const count = (kind: Registration['kind']): number => registrations.filter((registration) => registration.kind === kind).length;

  const application = applicationFiles(context);
  const upgradeImports = application.flatMap((file) => file.imports.filter((fact) => fact.specifier === '@angular/upgrade/static' || fact.specifier === '@angular/upgrade'));
  const imported = (name: string): boolean => upgradeImports.some((fact) => fact.bindings.some((binding) => binding.imported === name));
  const hybrid: AngularJsSummary['hybrid'] = imported('downgradeModule') ? 'downgradeModule' : imported('UpgradeModule') ? 'UpgradeModule' : imported('UpgradeAdapter') ? 'UpgradeAdapter' : undefined;

  const downgradedRegistrations = files.flatMap((file) => file.registrations.filter((registration) => registration.downgraded));
  // Templates alone never make an app AngularJS: an `ng-foo="…"` attribute can be anything in a page that
  // has no other trace of AngularJS. They count once the code or the dependencies say AngularJS.
  const templates = angularJs.templates.filter((template) => template.stats.attributes > 0 && (evidence || registrations.length > 0)).map((template) => ({ path: template.path, controllers: template.stats.controllers, includes: template.stats.includes }));
  const packages = ANGULARJS_PACKAGES.filter((entry) => entry.name in workspace.dependencies);
  const scopeFiles = files.filter((file) => file.scopeLines.length > 0);
  const hasCode = registrations.length > 0 || templates.length > 0 || files.some((file) => file.moduleDefinitions.length > 0);
  const sum = (pick: (file: AngularJsFileFacts) => number): number => files.reduce((total, file) => total + pick(file), 0);

  return {
    present: hasCode || evidence || 'angular' in workspace.dependencies || '@angular/upgrade' in workspace.dependencies || packages.length > 0,
    hasCode,
    ...(angularJs.version ? { version: angularJs.version.version, versionSource: angularJs.version.source } : {}),
    ...(hybrid ? { hybrid } : {}),
    ...(workspace.angular.major !== undefined ? { angularMajor: workspace.angular.major } : {}),
    files,
    registrations,
    components: count('component'),
    directives: count('directive'),
    controllers: count('controller'),
    services: registrations.filter((registration) => SERVICE_KINDS.has(registration.kind)).length,
    filters: count('filter'),
    uiUnits: registrations.filter((registration) => UI_KINDS.has(registration.kind)).length,
    angularComponents: application.reduce((total, file) => total + file.components.length, 0),
    angularServices: application.reduce((total, file) => total + file.injectables, 0),
    downgradedComponents: Math.max(countCalls(application, '@angular/upgrade/static#downgradeComponent'), downgradedRegistrations.filter((registration) => registration.kind === 'directive').length),
    downgradedServices: Math.max(countCalls(application, '@angular/upgrade/static#downgradeInjectable'), downgradedRegistrations.filter((registration) => registration.kind !== 'directive').length),
    upgradedComponents: sum((file) => file.upgradedComponents),
    upgradedServices: sum((file) => file.upgradedServices),
    scopeFiles,
    scopeEvents: sum((file) => file.scopeEventLines.length),
    watchers: sum((file) => file.watcherLines.length),
    compiles: sum((file) => file.compileLines.length),
    legacyDirectives: files.flatMap((file) => file.legacyDirectives.map((directive) => ({ path: file.path, ...directive }))),
    routes: sum((file) => file.routeLines.length),
    templates,
    templateControllers: templates.reduce((total, template) => total + template.controllers, 0),
    includes: templates.reduce((total, template) => total + template.includes, 0),
    javascriptFiles: files.filter((file) => file.language === 'js').length,
    packages,
    bower: angularJs.bower,
  };
}

/**
 * How much AngularJS is left and what stands in the way of moving it.
 *
 * AngularJS reached end of life on 31 December 2021, and nothing in it
 * carries over to Angular: every controller, directive, service, filter and
 * template is rewritten or wrapped. So the check counts what there is to
 * move, in the units a migration moves (components and directives, services,
 * filters, templates), and names what makes a unit hard to move:
 * controllers, `$scope`, scope events, runtime `$compile`, and directive
 * features `UpgradeComponent` rejects. For a hybrid app it also measures how
 * far the migration has come.
 *
 * Every count is a measure, so a baseline holds a running migration to
 * "AngularJS only ever shrinks".
 */
export function angularJsCheck(context: AnalysisContext): CheckResult {
  const s = summarizeAngularJs(context);
  const examples = context.maxExamples;
  const findings: Finding[] = [];
  const versionLabel = s.version ? `AngularJS ${s.version}` : 'AngularJS';
  const migrated = percent(s.angularComponents, s.angularComponents + s.uiUnits);

  if (s.hasCode || 'angular' in context.workspace.dependencies) {
    findings.push({
      severity: 'high',
      message: `${versionLabel} is end of life since January 2022`,
      detail:
        'Google ended AngularJS support on 31 December 2021: no security fixes, no fixes for new browsers, only paid third-party extended support. Nothing in AngularJS carries over to Angular; every controller, directive, service and template is rewritten or wrapped, which is why the migration goes piece by piece, with both frameworks running side by side in between.',
    });
  }

  const minor = s.version ? /^\D*1\.(\d+)/.exec(s.version)?.[1] : undefined;
  if (minor !== undefined && Number(minor) < 8) {
    findings.push({
      severity: Number(minor) < 5 ? 'medium' : 'low',
      message: `Move to AngularJS 1.8 before anything else (now ${s.version})`,
      detail:
        Number(minor) < 5
          ? '`.component()`, one-way bindings and lifecycle hooks arrived in 1.5, and the preparation steps of every migration path assume them. 1.8 is the last release.'
          : '1.8 is the last release. The steps from 1.5 are small and remove the deprecated behaviour (such as `$http` success/error callbacks) that the migration would otherwise carry along.',
    });
  }

  if (s.controllers > 0) {
    const list = s.registrations.filter((registration) => registration.kind === 'controller');
    findings.push({
      severity: 'medium',
      message: `${plural(s.controllers, 'controller')} registered with \`.controller()\`${s.templateControllers > 0 ? `, ${formatCount(s.templateControllers)} bound with \`ng-controller\`` : ''}`,
      detail:
        'A controller lives in a template or a route, and ngUpgrade bridges neither: only components and component-like directives can be upgraded to Angular or downgraded from it. Turning each controller into a `.component()` with explicit bindings is the first step of every migration path, and it ships on AngularJS alone.',
      files: refs(list, examples),
      count: list.length,
    });
  }

  if (s.legacyDirectives.length > 0) {
    findings.push({
      severity: 'medium',
      message: `${plural(s.legacyDirectives.length, 'directive')} ${verb(s.legacyDirectives.length, 'uses', 'use')} \`compile\`, \`replace\` or \`terminal\``,
      detail: '`UpgradeComponent` refuses these features (it throws "unsupported feature"), so these directives cannot be wrapped for use in Angular; they are rewritten, or reshaped as components first. `replace: true` has been deprecated since AngularJS 1.3.',
      files: s.legacyDirectives.slice(0, examples).map(({ path, line }) => ({ path, line })),
      count: s.legacyDirectives.length,
    });
  }

  if (s.scopeFiles.length > 0) {
    findings.push({
      severity: 'medium',
      message: `\`$scope\` in ${plural(s.scopeFiles.length, 'file')}`,
      detail:
        'Angular has no scope. State kept on `$scope` moves to the controller (`controllerAs`, `bindToController`) and to component bindings first, still on AngularJS; what remains is what the Angular version of each file has to redesign.',
      files: s.scopeFiles.slice(0, examples).map((file) => ({ path: file.path, line: file.scopeLines[0] })),
      count: s.scopeFiles.length,
    });
  }

  if (s.scopeEvents > 0) {
    const withEvents = s.files.filter((file) => file.scopeEventLines.length > 0);
    findings.push({
      severity: 'medium',
      message: `${plural(s.scopeEvents, 'scope event')} (\`$broadcast\`, \`$emit\`, \`$rootScope.$on\`) used as a message bus`,
      detail:
        'An event reaches whatever listens anywhere in the scope tree, invisible to the code that sends it, and in a hybrid app it stops at the framework border. A shared service with an RxJS `Subject`, made available to AngularJS with `downgradeInjectable`, carries the same messages to both sides.',
      files: withEvents.slice(0, examples).map((file) => ({ path: file.path, line: file.scopeEventLines[0] })),
      count: withEvents.length,
    });
  }

  if (s.compiles > 0) {
    const withCompile = s.files.filter((file) => file.compileLines.length > 0);
    findings.push({
      severity: 'medium',
      message: `${plural(s.compiles, 'runtime `$compile` call')}`,
      detail: 'Templates compiled at runtime have no direct Angular equivalent, since Angular compiles ahead of time and needs its components known at build time. These usually become dynamic components (`ViewContainerRef.createComponent`), or a redesign.',
      files: withCompile.slice(0, examples).map((file) => ({ path: file.path, line: file.compileLines[0] })),
      count: withCompile.length,
    });
  }

  if (s.watchers > 0) {
    const withWatchers = s.files.filter((file) => file.watcherLines.length > 0);
    findings.push({
      severity: 'low',
      message: `${plural(s.watchers, '`$watch` call')}`,
      detail: 'Each becomes a `computed` signal, an `effect`, or an input that reacts to change. A deep watch (`$watch(…, true)`) usually points at shared mutable state, which is worth untangling before the move rather than during it.',
      files: withWatchers.slice(0, examples).map((file) => ({ path: file.path, line: file.watcherLines[0] })),
      count: withWatchers.length,
    });
  }

  if (s.includes > 0) {
    const withIncludes = s.templates.filter((template) => template.includes > 0);
    findings.push({
      severity: 'low',
      message: `\`ng-include\` in ${plural(withIncludes.length, 'template')}`,
      detail: 'A template pulled in at runtime shares the scope of its parent, so its real inputs are whatever it happens to read. Each becomes a component with explicit inputs.',
      files: withIncludes.slice(0, examples).map((template) => ({ path: template.path })),
      count: withIncludes.length,
    });
  }

  if (s.packages.length > 0) {
    findings.push({
      severity: 'medium',
      message: `${plural(s.packages.length, 'AngularJS package')} to replace`,
      detail: s.packages.map((entry) => `\`${entry.name}\`: ${entry.replacement}`).join('; ') + '.',
    });
  }

  if (s.hybrid === 'UpgradeAdapter') {
    findings.push({
      severity: 'medium',
      message: 'The hybrid app runs on `UpgradeAdapter`',
      detail: '`UpgradeAdapter` from `@angular/upgrade` is deprecated since Angular 5 and works only with the JIT compiler. `UpgradeModule` (or `downgradeModule`) from `@angular/upgrade/static` replaces it and runs ahead of time.',
      files: filesImporting(applicationFiles(context), ['@angular/upgrade']).slice(0, examples),
    });
  }

  if (s.bower) {
    findings.push({
      severity: 'low',
      message: 'Dependencies are installed with Bower',
      detail: 'Bower is deprecated since 2017. Angular is installed from npm and built with the Angular CLI, so moving the dependencies to npm and a bundler is part of the preparation.',
      files: [{ path: 'bower.json' }],
    });
  }

  if (s.hasCode && s.javascriptFiles > 0 && s.javascriptFiles === s.files.length) {
    findings.push({
      severity: 'low',
      message: `The AngularJS code is plain JavaScript (${plural(s.javascriptFiles, 'file')})`,
      detail: 'Angular is written in TypeScript. Bringing TypeScript into the AngularJS code first (renaming files, `@types/angular`) makes every later step type-checked, and the services can then move to Angular almost unchanged.',
    });
  }

  if (s.hybrid) {
    findings.push({
      severity: 'info',
      message: `Hybrid app on \`${s.hybrid}\`: ${migrated}% of components on Angular`,
      detail: `${plural(s.angularComponents, 'Angular component')} and ${plural(s.uiUnits, 'AngularJS component, directive and controller', 'AngularJS components, directives and controllers')}. Across the border: ${formatCount(s.downgradedComponents)} downgraded and ${formatCount(s.upgradedComponents)} upgraded components, ${formatCount(s.downgradedServices)} downgraded and ${formatCount(s.upgradedServices)} upgraded services.`,
    });
  }

  if (!s.hasCode) {
    findings.push({
      severity: 'low',
      message: 'AngularJS packages are installed but no AngularJS code was found',
      detail: `Unless AngularJS code lives outside this repository, the packages are leftovers of a finished migration: ${['angular', '@angular/upgrade', ...s.packages.map((entry) => entry.name)].filter((name) => name in context.workspace.dependencies).map((name) => `\`${name}\``).join(', ')}.`,
    });
  }

  const grade: Grade = !s.hasCode ? 'fair' : s.hybrid && migrated >= MOSTLY_MIGRATED ? 'fair' : 'poor';
  const summary = !s.hasCode
    ? 'AngularJS packages without AngularJS code: leftovers to remove.'
    : s.hybrid
      ? `Hybrid ${versionLabel} and Angular${s.angularMajor !== undefined ? ` ${s.angularMajor}` : ''}: ${migrated}% of components on Angular, ${plural(s.uiUnits, 'AngularJS component')} left.`
      : `${versionLabel} app: ${plural(s.uiUnits, 'component, directive and controller', 'components, directives and controllers')}, ${plural(s.services, 'service')} and ${plural(s.templates.length, 'template')} to migrate.`;

  return {
    id: 'angularjs',
    title: 'AngularJS migration',
    grade,
    summary,
    metrics: [
      { label: 'AngularJS', value: s.version ?? 'unknown', hint: s.versionSource ?? 'version not found' },
      { label: 'Mode', value: s.hybrid ? `Hybrid (${s.hybrid})` : s.hasCode ? 'AngularJS only' : 'Leftovers' },
      { label: 'Components left', value: formatCount(s.uiUnits), hint: `${formatCount(s.components)} components, ${formatCount(s.directives)} directives, ${formatCount(s.controllers)} controllers` },
      { label: 'Services left', value: formatCount(s.services), hint: `and ${plural(s.filters, 'filter')}` },
      { label: 'Templates', value: formatCount(s.templates.length), hint: 'with AngularJS syntax' },
      ...(s.hybrid || s.angularComponents > 0 ? [{ label: 'Migrated', value: `${migrated}%`, hint: `${formatCount(s.angularComponents)} of ${formatCount(s.angularComponents + s.uiUnits)} components on Angular` }] : []),
    ],
    findings,
    measures: [
      { id: 'angularjs-components', label: 'AngularJS components, directives and controllers', value: s.uiUnits },
      { id: 'angularjs-controllers', label: 'AngularJS controllers', value: s.controllers },
      { id: 'angularjs-services', label: 'AngularJS services, factories and providers', value: s.services },
      { id: 'angularjs-filters', label: 'AngularJS filters', value: s.filters },
      { id: 'angularjs-templates', label: 'Templates with AngularJS syntax', value: s.templates.length },
      { id: 'scope-files', label: 'Files using $scope', value: s.scopeFiles.length },
    ],
  };
}

/** Example locations of some registrations. */
function refs(list: Array<{ path: string; line: number }>, max: number): FileRef[] {
  return list.slice(0, max).map(({ path, line }) => ({ path, line }));
}
