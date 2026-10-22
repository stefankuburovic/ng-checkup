import type { AngularJsSummary } from './checks/angularjs.js';
import type { PrimoSummary } from './checks/primo.js';
import { NDE_CUSTOM_MODULE_ANGULAR } from './primo.js';
import type { PlanItem } from './plan.js';

/** One phase of the AngularJS migration: what it achieves, and the work in this codebase. */
export interface MigrationPhase {
  title: string;
  /** What is true once the phase is done, in one sentence. */
  goal: string;
  items: PlanItem[];
}

/** The way from AngularJS to Angular. Attached to `Report.migration`. */
export interface MigrationPlan {
  /** `AngularJS 1.5.9`, or `AngularJS` when the version is unknown. */
  from: string;
  /** The Angular major the migration lands on: the installed one in a hybrid app on a current major, else the latest. */
  to: number;
  /** What the reports name as the destination, when it is more than `Angular <to>` (`Primo NDE`). */
  targetLabel?: string;
  mode: 'angularjs-only' | 'hybrid' | 'leftovers' | 'primo-nde';
  phases: MigrationPhase[];
}

/** The last AngularJS release, the version every migration path starts from. */
export const LAST_ANGULARJS = '1.8.3';

/** AngularJS's own packages, released in lockstep with `angular`. */
const CORE_PACKAGES = ['angular-animate', 'angular-aria', 'angular-cookies', 'angular-messages', 'angular-mocks', 'angular-resource', 'angular-route', 'angular-sanitize', 'angular-touch'];

/**
 * Plans the move from AngularJS to Angular in the order the upgrade guide
 * lays out and real migrations follow: make the AngularJS code look like
 * Angular components while it still runs on AngularJS alone, run both
 * frameworks side by side with `@angular/upgrade/static`, move the code
 * bottom up (services first, then leaf components), and remove AngularJS
 * when nothing needs it.
 *
 * Every item carries the count of places in this codebase it touches, and
 * an item the code does not need is left out, so a hybrid app that is
 * half-way sees only the remaining work. Like `buildPlan`, it gives no time
 * estimates: those belong to the consultant's notes (`--notes`).
 *
 * @param summary What the AngularJS check counted (`summarizeAngularJs`).
 * @param latest The newest Angular major.
 * @param upgradeSteps Steps of the Angular upgrade plan, for a hybrid app on an old Angular; 0 when there is none.
 * @param dependencies The workspace's dependencies, for the install and uninstall commands.
 * @returns Undefined when the repository has nothing AngularJS.
 */
export function buildMigrationPlan(summary: AngularJsSummary, latest: number, upgradeSteps: number, dependencies: Record<string, string>): MigrationPlan | undefined {
  if (!summary.present) return undefined;
  const from = summary.version ? `AngularJS ${summary.version}` : 'AngularJS';
  const installed = (names: string[]): string[] => names.filter((name) => name in dependencies);
  const leftoverPackages = installed(['angular', '@angular/upgrade', ...CORE_PACKAGES, ...summary.packages.map((entry) => entry.name)]);
  const uninstall = leftoverPackages.length > 0 ? `npm uninstall ${[...new Set(leftoverPackages)].join(' ')}` : undefined;

  if (!summary.hasCode) {
    return {
      from,
      to: summary.angularMajor ?? latest,
      mode: 'leftovers',
      phases: [{ title: 'Remove AngularJS', goal: 'No AngularJS package is left in the build.', items: [{ title: 'Uninstall the AngularJS packages', command: uninstall, detail: 'No AngularJS code was found that still needs them.' }] }],
    };
  }

  const prepare: PlanItem[] = [];
  const minor = summary.version ? /^\D*1\.(\d+)/.exec(summary.version)?.[1] : undefined;
  if (minor !== undefined && Number(minor) < 8) {
    const packages = ['angular', ...installed(CORE_PACKAGES)].map((name) => `${name}@${LAST_ANGULARJS}`);
    prepare.push({ title: `Upgrade AngularJS to ${LAST_ANGULARJS}`, command: summary.bower ? undefined : `npm install ${packages.join(' ')}`, detail: 'The last release; read the migration notes of each minor on the way.' });
  }
  if (summary.bower) prepare.push({ title: 'Move the dependencies from Bower to npm', detail: 'Angular is installed from npm and built with the Angular CLI; the AngularJS side has to be part of the same build.' });
  if (summary.javascriptFiles > 0) prepare.push({ title: 'Bring TypeScript into the AngularJS code', detail: 'Rename the files to `.ts`, add `@types/angular`, and tighten types file by file. Services written in TypeScript move to Angular almost unchanged.', count: summary.javascriptFiles });
  if (summary.controllers > 0) prepare.push({ title: 'Turn controllers into components', detail: `Explicit bindings instead of an inherited scope${summary.templateControllers > 0 ? `, and no more \`ng-controller\` in templates (${summary.templateControllers})` : ''}. Only components cross the border between the two frameworks.`, count: summary.controllers });
  if (summary.legacyDirectives.length > 0) prepare.push({ title: 'Reshape directives that use `compile`, `replace` or `terminal`', detail: '`UpgradeComponent` cannot wrap them.', count: summary.legacyDirectives.length });
  if (summary.scopeFiles.length > 0) prepare.push({ title: 'Move state off `$scope`', detail: '`controllerAs` and `bindToController`, so the controller is the component class it will become.', count: summary.scopeFiles.length });
  if (summary.scopeEvents > 0) prepare.push({ title: 'Replace scope events with services', detail: 'A service with an RxJS `Subject` instead of `$broadcast`/`$emit`; it later carries the messages across the border.', count: summary.scopeEvents });
  if (summary.includes > 0) prepare.push({ title: 'Turn `ng-include` templates into components', count: summary.includes });

  const hybrid: PlanItem[] = [];
  if (!summary.hybrid) {
    hybrid.push({
      title: `Add Angular ${latest} next to AngularJS`,
      detail: 'An Angular CLI build that bundles the AngularJS code too, with `@angular/upgrade` installed at the same version.',
    });
    hybrid.push({
      title: 'Bootstrap both frameworks on one page',
      detail: '`UpgradeModule` from `@angular/upgrade/static` is the simplest start; `downgradeModule` keeps the two change detections apart, which matters in large apps. With `UpgradeModule`, Angular bootstraps and then starts AngularJS from `ngDoBootstrap`.',
    });
  } else if (summary.hybrid === 'UpgradeAdapter') {
    hybrid.push({ title: 'Move from `UpgradeAdapter` to `UpgradeModule`', detail: '`UpgradeAdapter` is deprecated and needs the JIT compiler.' });
  }
  if (summary.hybrid && upgradeSteps > 0) {
    hybrid.push({ title: `Bring the Angular side up to ${latest}`, detail: 'New code should be written on a current Angular. The upgrade plan below lists each `ng update` step; `@angular/upgrade` moves with `@angular/core`.', count: upgradeSteps });
  }
  if (summary.routes > 0) {
    const uiRouter = summary.packages.some((entry) => entry.name === '@uirouter/angularjs' || entry.name === 'angular-ui-router');
    hybrid.push({
      title: uiRouter ? 'Run UI-Router in hybrid mode' : 'Let the two routers share the URL',
      detail: uiRouter ? '`@uirouter/angular-hybrid` lets AngularJS and Angular states live in one state tree.' : 'ngRoute keeps the AngularJS routes, the Angular Router takes over route by route; `setUpLocationSync` from `@angular/router/upgrade` keeps both in step.',
      count: summary.routes,
    });
  }

  const move: PlanItem[] = [];
  if (summary.services > 0) move.push({ title: 'Move services to Angular, oldest dependencies first', detail: 'Each becomes an `@Injectable` and stays available to AngularJS through `downgradeInjectable` until its last AngularJS user is gone.', count: summary.services });
  if (summary.filters > 0) move.push({ title: 'Turn filters into pipes', count: summary.filters });
  if (summary.uiUnits > 0) move.push({ title: 'Move components and directives, leaves first', detail: 'A rewritten component is used from AngularJS through `downgradeComponent`; an AngularJS component still needed inside Angular is wrapped with `UpgradeComponent` for the time being.', count: summary.uiUnits });
  if (summary.templates.length > 0) move.push({ title: 'Rewrite the templates in Angular syntax', detail: '`ng-repeat` becomes `@for`, `ng-if` becomes `@if`, `ng-model` becomes a form control or a model input, `ng-click` an event binding.', count: summary.templates.length });
  if (summary.compiles > 0) move.push({ title: 'Replace runtime `$compile` with dynamic components', count: summary.compiles });
  if (summary.watchers > 0) move.push({ title: 'Replace `$watch` with signals', detail: '`computed` for derived values, `effect` or an input for reactions.', count: summary.watchers });
  for (const entry of summary.packages.filter((candidate) => candidate.name !== 'angular-mocks')) move.push({ title: `Replace \`${entry.name}\``, detail: `With ${entry.replacement}.` });
  if (summary.packages.some((entry) => entry.name === 'angular-mocks')) move.push({ title: 'Move the AngularJS unit tests to `TestBed`', detail: 'Along with the code they test; a spec moves in the same change as its component or service.' });

  const remove: PlanItem[] = [];
  if (summary.routes > 0) remove.push({ title: 'Move the last routes to the Angular router', count: summary.routes });
  const borders = summary.downgradedComponents + summary.downgradedServices + summary.upgradedComponents + summary.upgradedServices;
  if (borders > 0) remove.push({ title: 'Remove the downgrade and upgrade wrappers', detail: 'Nothing on the AngularJS side uses them any more.', count: borders });
  remove.push({ title: 'Bootstrap Angular alone and uninstall AngularJS', command: uninstall, detail: 'Drop `UpgradeModule` and the AngularJS bootstrap; the bundle loses AngularJS and the second change detection.' });

  const phases: MigrationPhase[] = [
    { title: 'Prepare on AngularJS', goal: 'The AngularJS code is made of components and services, written the way Angular expects them; it still ships on AngularJS alone.', items: prepare },
    { title: summary.hybrid ? 'Hybrid setup' : 'Run Angular next to AngularJS', goal: 'Both frameworks run on one page, and new features are written in Angular.', items: hybrid },
    { title: 'Move piece by piece, bottom up', goal: 'Every service, component and template is Angular code; each step ships on its own.', items: move },
    { title: 'Remove AngularJS', goal: 'One framework, one build, one change detection.', items: remove },
  ].filter((phase) => phase.items.length > 0);

  return { from, to: summary.hybrid && summary.angularMajor !== undefined && upgradeSteps === 0 ? summary.angularMajor : latest, mode: summary.hybrid ? 'hybrid' : 'angularjs-only', phases };
}

/**
 * Plans the move of a Primo VE customization package to the NDE custom
 * module, in the order a library can work through it: decide what still
 * needs customizing (NDE does some of it out of the box), set up the module
 * and move the branding and static pages, rebuild the hooks as Angular
 * components (central package first, since every view loads it), then test
 * against the live view in proxy mode and switch view by view.
 *
 * As with `buildMigrationPlan`, every item carries this package's count and
 * no estimate: how long a hook takes depends mostly on its `parentCtrl`
 * reads, which the counts show and only a person can price.
 */
export function buildPrimoPlan(summary: PrimoSummary): MigrationPlan | undefined {
  if (!summary.present) return undefined;
  const central = summary.views.find((view) => view.central);
  const homePages = [...new Set(summary.views.flatMap((view) => view.homePages))];

  const decide: PlanItem[] = [
    {
      title: 'Check each customization against NDE as it ships',
      detail: 'NDE was redesigned from the ground up; some VE customizations fill gaps it no longer has. Dropping those first is the cheapest part of the migration.',
      count: summary.hooks + summary.components,
    },
    {
      title: `Set up the NDE custom module (Angular ${NDE_CUSTOM_MODULE_ANGULAR})`,
      command: 'git clone https://github.com/ExLibrisGroup/customModule.git && cd customModule && npm install',
      detail: 'Set the institution and view in `build-settings.env`; `npm run build` writes the package to upload per view.',
    },
  ];

  const branding: PlanItem[] = [
    { title: 'Move logos, images and CSS', detail: 'Images to `src/assets/images`, CSS to `src/assets/css/custom.css` or the Material 3 theme in `src/app/styles`.', count: summary.views.length },
  ];
  if (homePages.length > 0) branding.push({ title: 'Move the static home pages', detail: `To \`src/assets/homepage/homepage_<lang>.html\`; AngularJS markup in them has to go. Languages: ${homePages.join(', ')}.`, count: homePages.length });

  const rebuild: PlanItem[] = [];
  if (central && central.hooks.length > 0) rebuild.push({ title: 'Rebuild the central package first', detail: `\`${central.root}\` is loaded by every view, so its hooks are done once for all of them.`, count: central.hooks.length });
  rebuild.push({
    title: 'Rebuild each hook as an Angular component',
    detail: 'Map it in `selectorComponentMap` to the matching `nde-…-before`, `-after`, `-top` or `-bottom` selector, found in the NDE UI.',
    count: summary.hooks,
  });
  if (summary.components > 0) rebuild.push({ title: 'Rebuild the helper components the hooks render', count: summary.components });
  if (summary.parentCtrlReads > 0) rebuild.push({ title: 'Replace `parentCtrl` reads', detail: 'With `@Input() hostComponent` or NgRx store selectors (`store.selectSignal(...)`).', count: summary.parentCtrlReads });
  if (summary.httpCalls > 0) rebuild.push({ title: 'Move `$http` requests to `HttpClient`', count: summary.httpCalls });
  for (const integration of summary.integrations) rebuild.push({ title: `Rebuild or replace ${integration}`, detail: 'Check for the vendor\'s NDE version first.' });

  const ship: PlanItem[] = [
    { title: 'Test against the live view in proxy mode', command: 'npm run start:proxy', detail: 'Or open the NDE view with `?useLocalCustomPackage=true` while `npm run start` runs.' },
    { title: 'Build, upload and switch view by view', command: 'npm run build', detail: 'Before January 2028, when NDE is announced as the only UI.', count: summary.views.length },
  ];

  const phases: MigrationPhase[] = [
    { title: 'Decide and set up', goal: 'A list of the customizations NDE still needs, and the custom module building for your institution and view.', items: decide },
    { title: 'Branding and static pages', goal: 'The NDE view looks like the library again.', items: branding },
    { title: 'Rebuild the hooks', goal: 'Every customization that is still needed runs as an Angular component in NDE.', items: rebuild },
    { title: 'Test and switch', goal: 'Each view runs on NDE, before the VE UI goes away.', items: ship },
  ];
  return { from: 'Primo VE customizations (AngularJS)', to: NDE_CUSTOM_MODULE_ANGULAR, targetLabel: 'Primo NDE', mode: 'primo-nde', phases };
}
