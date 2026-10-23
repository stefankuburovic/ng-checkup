# The checks

Twelve checks run on every repository. A thirteenth runs first when there is legacy code: [AngularJS migration](#angularjs) for AngularJS code or packages, or, for an Ex Libris Primo VE customization package, [Primo NDE migration](#primo-nde) in its place.

Every check grades one area **good**, **fair**, **poor** or **info**. `info` means there was nothing to grade (no components, no tests) or an input was missing (no `node_modules`), and it never counts against the score.

The score is the average of the graded areas: good counts 100, fair 60, poor 20.

- [Primo NDE migration](#primo-nde) (only for a Primo VE package)
- [AngularJS migration](#angularjs) (only with AngularJS)
- [Angular version & tooling](#version)
- [Deprecated APIs](#deprecated-apis)
- [Third-party compatibility](#dependencies)
- [Change detection & zoneless readiness](#change-detection)
- [Components & templates](#components)
- [State management](#state)
- [Architecture](#architecture)
- [Testing](#testing)
- [Type safety](#type-safety)
- [Security](#security)
- [Circular dependencies](#circular-deps)
- [Bundle size](#bundle)

In a monorepo every project also gets its own grade on the code checks (everything except the version and third-party checks, which the projects share); see [Monorepos](../README.md#monorepos).

The id in parentheses is what the JSON report uses, and what `--only` and `--skip` take: `--only security,dependencies` reports those two areas, `--skip bundle` leaves one out. Every check still runs, but a left-out area is not in the report, the score or the baseline.

---

## Primo NDE migration (`primo-nde`) <a id="primo-nde"></a>

Only for a repository holding an Ex Libris Primo VE customization package: the AngularJS module `viewCustom`, or components registered under Primo's hook names (`prmSearchBarAfter`). It replaces the AngularJS area, whose hybrid route does not apply: a Primo package is rebuilt in the NDE custom module ([ExLibrisGroup/customModule](https://github.com/ExLibrisGroup/customModule), Angular 18 in October 2026), not upgraded in place.

**Looks at:** every view folder (a folder holding `js/`; a network's `…CENTRAL_PACKAGE` is the central package). Per view, each hook once (`prm-search-bar-after`), the helper components and directives the hooks render (controllers are not counted, Primo registers one per component), `parentCtrl` reads (`parentCtrl.x` and `parentCtrl[…]`, not the `parentCtrl: '<'` binding every hook declares) with the paths read most, `$http` calls, third-party integrations named in the code (BrowZine/LibKey, Altmetric, Unpaywall, Google Analytics/Tag Manager, Matomo, LibChat, LibraryH3lp, HathiTrust, StackMap), and static home pages (`html/home_<lang>.html`, `html/homepage/homepage_<lang>.html`). A `js/custom.js` that only concatenates the view's other files is not counted again, and neither are copies outside the view folders.

**Findings:** NDE replaces VE and customizations do not carry over (high), the hooks to rebuild, `parentCtrl` reads, integrations, the central package, home pages.

**Grade:** poor when `parentCtrl` is read or more than ten hooks are filled; fair otherwise.

**Plan:** with `--plan`, `report.migration` (mode `primo-nde`) has four phases: decide what NDE still needs and set up the custom module, branding and home pages, rebuild the hooks (central package first), test in proxy mode and switch view by view.

## AngularJS migration (`angularjs`) <a id="angularjs"></a>

Only in a report whose repository has AngularJS: code, templates, or the `angular` or `@angular/upgrade` package. For every other Angular app it would be a line saying "not applicable", so it is left out.

**Looks at:** JavaScript and TypeScript files. Registrations (`.component`, `.directive`, `.controller`, `.service`, `.factory`, `.provider`, `.filter`) are counted when their call chain starts at `angular.module(…)`, directly or through a variable assigned from it; a registration on a module from another file (`app.controller(…)`) counts once the repository shows AngularJS elsewhere, so `Vue.component(…)` in a Vue app never does. Spec files and checked-in copies of AngularJS (recognised by their license header) are left out, and so are `vendor`, `bower_components` and minified files. Templates count when they hold `ng-*="…"` attributes, except the bootstrap ones (`ng-app`) and the `ng-reflect-*` attributes Angular itself writes into the DOM.

**Hybrid apps:** `UpgradeModule`, `downgradeModule` or `UpgradeAdapter` imported from `@angular/upgrade`. "Migrated" is the share of Angular components among all components, directives and controllers; a `.directive('x', downgradeComponent(…))` or `.factory('x', downgradeInjectable(…))` registration is Angular code and counts as migrated.

**Findings:** end of life (high), a version before 1.8, controllers and `ng-controller`, directives using `compile`, `replace: true` or `terminal: true` (which `UpgradeComponent` rejects), `$scope`, scope events (`$rootScope.$broadcast/$emit/$on`, `$scope.$broadcast/$emit`), runtime `$compile`, `$watch`, `ng-include`, AngularJS packages with their replacement, `UpgradeAdapter`, Bower, plain JavaScript, and packages left over without code.

**Grade:** poor while AngularJS code is left; fair for a hybrid app with at least 80% of its components on Angular, and for leftover packages without code.

**Plan:** with `--plan`, `report.migration` holds four phases (prepare on AngularJS, run both frameworks, move bottom up, remove AngularJS) with a count per item. Items the code does not need are left out.

## Angular version & tooling (`version`) <a id="version"></a>

**What it reads:** the installed `@angular/core` version (the `package.json` range when dependencies are not installed), the latest version on npm, every `@angular/*` package's major, the build targets in `angular.json` or the Nx `project.json` files, and a short list of end-of-life packages.

**Grading**

| Grade | When |
| --- | --- |
| good | on the latest major or one behind |
| fair | two majors behind, a project built only with a webpack-based builder (an extra webpack target beside an esbuild build does not count), mixed `@angular/*` majors, or end-of-life tooling (Protractor, TSLint, codelyzer, node-sass) |
| poor | three or more majors behind (out of support), or an end-of-life runtime package (`@angular/http`, `@angular/flex-layout`) |

Angular releases a major roughly every six months and supports each for 18 months, so the newest three are supported. `ng update` moves one major at a time, so the gap is also the number of upgrade steps.

**Fixing it:** `ng update @angular/core@<next> @angular/cli@<next>`, one major at a time, reviewing each step's migrations. For the builder: `ng update @angular/cli --name use-application-builder`.

---

## Deprecated APIs (`deprecated-apis`) <a id="deprecated-apis"></a>

**What it reads:** the `@deprecated` tags in the `@angular/*`, `@ngrx/*` and `rxjs` type definitions of the versions the project uses (installed in `node_modules`, else the versions the lockfile pins, downloaded once from npm and cached), matched against every symbol your code imports from those packages, plus enum members such as `ChangeDetectionStrategy.Default`. Templates are scanned for `*ngIf`, `*ngFor` and `[ngSwitch]`, which no import reveals. On RxJS 7 and later, `.toPromise()` calls are counted too: an instance method no import shows, removed in RxJS 8 in favour of `firstValueFrom` / `lastValueFrom`.

An app that does not use RxJS or NgRx simply has nothing from them to report. The "deprecated two majors ago" rule applies to Angular and NgRx only, whose majors move together; RxJS deprecations are reported but never make the area poor on their own.

There is no hand-kept list. The report shows exactly what the installed version marks, with Angular's own wording and version. A function counts as deprecated only when every overload is, and Angular's private `ɵ` names are ignored.

**Grading**

| Grade | When |
| --- | --- |
| good | nothing deprecated in use |
| fair | deprecated APIs in use, all deprecated less than two majors ago |
| poor | an API deprecated two or more majors before the installed version, which any upgrade may remove; or an import the next major no longer exports |
| info | dependencies are not installed |

**The next major.** The check also downloads the type definitions of the next Angular major (the newest release of it) for the `@angular/*` and `@ngrx/*` packages your code imports, and compares them with the installed ones:

- an imported name the next major **no longer exports** is a `high` finding: that import stops compiling after `ng update`, so it is replaced before that step. The upgrade plan's first step lists the same names;
- an imported name or enum member the next major **newly deprecates** is a `low` finding. It still works after the upgrade, so it does not change the grade; it is advance notice of what to replace within the following two majors.

A name counts as removed only when the installed typings export it and the next major's do not, so a name neither version shows readably is never reported as removed. When the project is on the latest major and npm's `next` tag is a prerelease of the one after, that prerelease is compared instead: during an Angular RC, the report already says what the new major breaks. Offline, only typings already in the cache are compared, and without them nothing is said.

**Fixing it:** each finding quotes Angular's replacement. For templates: `ng generate @angular/core:control-flow`.

---

## Third-party compatibility (`dependencies`) <a id="dependencies"></a>

**What it reads:** the `peerDependencies['@angular/core']` range of every dependency (from `node_modules`, else from the npm registry for the version the lockfile pins), so any UI kit, state library or utility is covered without a list of known names. Angular's own packages, NgRx and Nx are left out, since `ng update` and `nx migrate` move them. Online, it asks the npm registry for each package's releases: the first one that supports each next Angular major, and whether the package is deprecated.

**Grading**

| Grade | When |
| --- | --- |
| good | every package accepts the installed Angular and all majors up to the latest |
| fair | a package blocks a later upgrade step but has a release that supports it, or a package is deprecated on npm |
| poor | a package does not accept the installed Angular (installed with `--force`, `--legacy-peer-deps` or an override), or no release supports the latest Angular |
| info | dependencies are not installed |

With `--plan`, each package update is scheduled at the step that needs it ("Update ngx-x to 5.0.0" at the step to 19), and a package with no release for a major says so at that step.

**Fixing it:** update the package at the step the plan names; for one with no release, plan its replacement, or stop at the last major it supports.

---

## Change detection & zoneless readiness (`change-detection`) <a id="change-detection"></a>

**What it reads:** whether the app is zoneless (`provideZonelessChangeDetection()` before Angular 21; the absence of `provideZoneChangeDetection()` from 21 on, where zoneless is the default), each component's `changeDetection`, files that inject `NgZone`, and zone-only test helpers (`fakeAsync`, `tick`, `waitForAsync`, `flush`).

From Angular 22, OnPush is the default, so a component without `changeDetection` counts as OnPush there and as eager before.

**Grading**

| Grade | When |
| --- | --- |
| good | zoneless |
| fair | zone.js, with at least half of the components on OnPush |
| poor | zone.js, with less than half on OnPush |

**Fixing it:** move components to OnPush first (each one now has to notify Angular through signals, `markForCheck()`, the async pipe or events), then switch to zoneless and rewrite zone-based test helpers with fake timers.

---

## Components & templates (`components`) <a id="components"></a>

**What it reads:** standalone vs. NgModule-declared components (standalone is the default from Angular 19), `input()` / `model()` / `output()` vs. `@Input()` / `@Output()`, built-in control flow (`@if`, `@for`, `@switch`) vs. structural directives, and `@defer` blocks.

**Grading:** the average adoption of standalone, signal inputs and built-in control flow, counting only the areas the code uses: 80% or more is good, 40% or more is fair, below that is poor.

**Fixing it**

```bash
ng generate @angular/core:standalone
ng generate @angular/core:signal-input-migration
ng generate @angular/core:output-migration
ng generate @angular/core:control-flow
```

---

## State management (`state`) <a id="state"></a>

**What it reads:** files importing classic NgRx (`@ngrx/store`, `@ngrx/effects`, `@ngrx/entity`, `@ngrx/router-store`, `@ngrx/component-store`) with their reducers, effects, selectors and action creators; files using `@ngrx/signals`; `signal()` / `computed()` / `linkedSignal()` calls; and injectable services that hold state in a `BehaviorSubject`.

**Grading**

| Grade | When |
| --- | --- |
| good | signals in use and no classic NgRx |
| fair | classic NgRx, or `BehaviorSubject` services without signals |
| poor | the `@Effect()` decorator, removed in NgRx 15 |

Classic NgRx is supported, so it never makes this check poor on its own. The check measures the distance to signals, not a defect.

---

## Architecture (`architecture`) <a id="architecture"></a>

**What it reads:** route objects (`{ path, component }` is eager, `{ path, loadComponent }` or `{ path, loadChildren }` is lazy), file sizes in lines of code, constructors of components, directives, pipes and services, and classes implementing a router guard or resolver interface or `HttpInterceptor`.

A `component:` route counts as eager only in a file the app loads at startup: everything statically reachable from the build target's `main.ts`. In a module that is itself behind `loadChildren`, the route loads with that module and counts as lazy.

**Grading**

| Grade | When |
| --- | --- |
| good | most routes are lazy and no file is over 1 000 lines |
| fair | more eager than lazy routes (with five or more routes), or a file over 1 000 lines (file size alone never makes the area poor: long files are a refactoring list, the hotspots below say which first) |
| poor | ten or more eager routes and none lazy |

Constructor injection and class-based guards are reported as low findings but never change the grade: they work, they are only the older style. `inject()` and functional guards are what current Angular and its migrations produce.

**Hotspots.** In a git repository with its history, the check also reads how often each file changed in the last twelve months (`git log`, merges left out, limited to the analysed folder). A file of at least 300 lines changed in at least 10 commits is a hotspot, ranked by lines times commits, and the five worst are listed: that is where a refactoring pays off first, since the file is read and edited all the time. Hotspots never change the grade and are not a baseline measure, because the count moves with how busy the team is, not with the code. In a shallow clone (`fetch-depth: 1` in CI, a remote repository argument) there is one commit of history, and the report says so instead of ranking nothing.

**Fixing it:** `loadComponent: () => import('./x').then((m) => m.X)` per route; `ng generate @angular/core:inject` for constructors; functional guards (`CanActivateFn`) and interceptors (`HttpInterceptorFn` with `withInterceptors`). Large files are split by responsibility, the largest first.

---

## Testing (`testing`) <a id="testing"></a>

**What it reads:** the unit-test runner from the test targets' builders and the dependencies (Karma, Jest, Vitest), spec files, and which components, services, signal stores and utility files have a spec: a `x.spec.ts` next to `x.ts`, or any spec that imports the file (directly or through a barrel), Jasmine-only calls (`spyOn`, `jasmine.*`), and the end-to-end setup (Protractor, Playwright, Cypress).

"Has a spec next to it" is a proxy for coverage, not coverage: it needs no test run, which is what lets the tool run on a repository it has never seen.

**Grading**

| Grade | When |
| --- | --- |
| good | a current runner and at least 30% of components, services, stores and utilities with a spec |
| fair | under 30% with a spec |
| poor | Karma, Protractor, or no specs at all |

**Fixing it:** the Angular CLI's default runner is Vitest since v21 (`@angular/build:unit-test`). The finding counts the Jasmine-specific calls a move would touch.

---

## Type safety (`type-safety`) <a id="type-safety"></a>

**What it reads:** `strictNullChecks`, `noImplicitAny` and `strict` from the application tsconfig (with `extends` resolved), `strictTemplates` from `angularCompilerOptions`, and the escape hatches: explicit `any` per 1 000 lines (an `any` under an eslint-disable for `no-explicit-any`, on its line, the line before or in a disable/enable block, is reported apart and left out of the count, so the number matches the project's own lint rule), non-null assertions (`x!`), `@ts-ignore` / `@ts-expect-error`, `$any()` in templates and `UntypedForm*` imports.

**Grading**

| Grade | When |
| --- | --- |
| good | `strictNullChecks`, `strictTemplates` and `noImplicitAny` on, at most 2 `any` per 1 000 lines |
| fair | one of them off, or more `any` than that |
| poor | both `strictNullChecks` and `strictTemplates` off |

A flag the tsconfig does not set takes the default of the version you run: `strict` is on by default from TypeScript 6, `strictTemplates` from Angular 22 (17 to 21 default to off). A new Angular 22 project sets neither and is fully strict. The report marks such values "default in TypeScript 6" or "default in Angular 22".

**Fixing it:** in a large codebase, stage it: a separate tsconfig that checks one folder at a time, and a count in CI that may only go down.

---

## Security (`security`) <a id="security"></a>

**What it reads:** the published advisories for the dependencies, and the places where code steps around Angular's built-in XSS protection.

**Known vulnerabilities.** Every direct dependency at its exact version (installed, or pinned in the lockfile) is looked up in [OSV](https://osv.dev), which carries the GitHub advisories for npm. AngularJS loaded from Bower, a CDN or a checked-in copy is looked up as the npm package `angular`. The finding lists each package with its CVE ids and the nearest fixed version; dependencies used only in `devDependencies` get a separate low finding, since they never reach users. Direct dependencies only: the full tree is `npm audit`'s job, and the direct ones are those the codebase chose and can upgrade. Offline, or when osv.dev does not answer within eight seconds, the lookup is skipped and the report says "not checked". It is not a baseline measure: the count grows when an advisory is published, not when the code gets worse.

**Escape hatches,** in application files (specs are left out):

- `bypassSecurityTrustHtml`, `…Style`, `…Script`, `…Url`, `…ResourceUrl` calls;
- HTML written straight into the DOM: assignments to `innerHTML` / `outerHTML`, `insertAdjacentHTML`, `document.write`, `Renderer2.setProperty(el, 'innerHTML', …)`;
- strings run as code: `eval` and `new Function`;
- `[innerHTML]` / `[outerHTML]` bindings in templates.

Angular sanitizes every bound value, so an Angular app is safe from cross-site scripting by default. The check counts the escape hatches; it cannot tell a constant from user input, so each finding is a place to review, not a proven hole.

**Grading**

| Grade | When |
| --- | --- |
| good | none of the above, apart from `[innerHTML]` bindings (which Angular sanitizes), and no known vulnerability in a runtime dependency |
| fair | `bypassSecurityTrust*` calls: each needs a look at where its value comes from; or a moderate advisory in a runtime dependency |
| poor | HTML written into the DOM past the sanitizer, or `eval` / `new Function`: these skip sanitization for every value; or a high or critical advisory in a runtime dependency |

**Fixing it:** upgrade a vulnerable package to the fixed version the finding names (AngularJS advisories name none: 1.8.3 is the last release, and the fix is the migration); bind HTML with `[innerHTML]` instead of writing it to the element; sanitize user content with an allow-list sanitizer such as DOMPurify before trusting it; replace `eval` with a lookup table or `JSON.parse`.

---

## Circular dependencies (`circular-deps`) <a id="circular-deps"></a>

**What it reads:** every static, value-level import between application files, resolved like the Angular CLI does (relative paths, `index.ts` barrels and tsconfig `paths` aliases). `import()` and test code are ignored, and so is every import TypeScript erases: `import type`, and also a plain import whose names the file uses only as types (`store: Store`), or that names only types (`export type ID = string`), directly or through a barrel. None of those exists at runtime, so none can cause an initialization-order crash. One Angular rule keeps a real cycle visible: the constructor parameter types of a decorated class are DI tokens, so they count as runtime references.

Cycles are reported as **groups** of files that import each other in a loop (strongly connected components), each with one concrete loop to cut. Counting individual cycles grows combinatorially and gives numbers nobody can act on.

**Grading**

| Grade | When |
| --- | --- |
| good | no cycles |
| fair | up to three groups with ten files in total |
| poor | more than that |

**Fixing it:** most loops close through a barrel import that drags in a sibling. Importing the file directly instead of `./index` usually breaks it.

---

## Bundle size (`bundle`) <a id="bundle"></a>

**What it reads:** the stats file of the last `ng build --stats-json`: `browser-stats.json` (Angular 18 and later) or `stats.json` (Angular 17's esbuild builder and every webpack build), in each application's output folder. It does not build anything.

The initial bundle is counted the way the Angular CLI's "Initial total" is: the entry scripts, everything they import statically, and the global styles. Lazy routes and `@defer` blocks are lazy chunks. The budget is the build target's own `initial` budget from its production configuration, else Angular's default of 500 kB (warning) and 1 MB (error).

**Grading**

| Grade | When |
| --- | --- |
| good | under the warning budget |
| fair | over the warning budget |
| poor | over the error budget |
| info | no stats file found |

The largest packages in the initial bundle are listed with their size, from the metafile's per-input byte counts. The stats file's date is in the summary: a file from an old build describes an old bundle. Bundle size is not a baseline measure, since it grows with every feature; the budget is the limit.

**Fixing it:** lazy routes and `@defer` for screens and heavy widgets; replace or lazy-load the largest packages the report lists.

---

## Measures recorded by the baseline <a id="measures"></a>

`ng-checkup baseline` records these counts in `ng-checkup.baseline.json`, and `--fail-on regression` fails when any of them goes up. Lower is better for every one. The number of majors behind is deliberately not a measure: it grows when Angular ships a release, not when the code gets worse. Neither is bundle size, which grows with every feature.

| Key | Counts |
| --- | --- |
| `primo-nde.parentctrl-reads` | Reads of `parentCtrl` in a Primo VE package |
| `primo-nde.primo-helper-components` | Helper components of a Primo VE package |
| `primo-nde.primo-hooks` | Primo hooks filled, per view |
| `primo-nde.primo-integrations` | Third-party integrations in a Primo VE package |
| `angularjs.angularjs-components` | AngularJS components, directives and controllers |
| `angularjs.angularjs-controllers` | AngularJS controllers |
| `angularjs.angularjs-filters` | AngularJS filters |
| `angularjs.angularjs-services` | AngularJS services, factories and providers |
| `angularjs.angularjs-templates` | Templates with AngularJS syntax |
| `angularjs.scope-files` | Files using `$scope` |
| `architecture.class-guards` | Class-based guards and interceptors |
| `architecture.constructor-injection` | Classes with constructor injection |
| `architecture.eager-routes` | Eagerly loaded routes (in files loaded at startup) |
| `architecture.very-large-files` | Files over 1000 lines |
| `change-detection.eager-components` | Components with eager change detection |
| `change-detection.ngzone-files` | Files injecting NgZone |
| `change-detection.zone-test-helpers` | Zone-based test helper calls |
| `circular-deps.files-in-cycles` | Files in import cycles |
| `components.decorator-inputs-outputs` | `@Input()` / `@Output()` decorators |
| `components.legacy-control-flow` | `*ngIf` / `*ngFor` / `[ngSwitch]` uses |
| `components.module-components` | Components declared in NgModules |
| `dependencies.deprecated-packages` | Packages deprecated on npm |
| `dependencies.peer-mismatches` | Packages that do not accept the installed Angular |
| `deprecated-apis.deprecated-usages` | Deprecated API uses (symbol × file) |
| `deprecated-apis.legacy-template-directives` | `*ngIf` / `*ngFor` / `[ngSwitch]` uses |
| `deprecated-apis.to-promise-calls` | `.toPromise()` calls |
| `security.dynamic-code` | `eval` and `new Function` calls |
| `security.inner-html-bindings` | `[innerHTML]` bindings |
| `security.sanitizer-bypasses` | `bypassSecurityTrust*` calls |
| `security.unsafe-dom-writes` | Direct DOM HTML writes |
| `state.behaviorsubject-services` | Services holding state in a `BehaviorSubject` |
| `state.classic-ngrx-files` | Files on classic NgRx |
| `state.effect-decorators` | Removed `@Effect()` decorators |
| `testing.untested-files` | Components and services without a spec |
| `type-safety.explicit-any` | Explicit `any` in application code |
| `type-safety.non-null-assertions` | Non-null assertions (`x!`) |
| `type-safety.strict-flags-off` | `strictNullChecks` / `strictTemplates` / `noImplicitAny` off |
| `type-safety.template-any-casts` | `$any()` casts in templates |
| `type-safety.ts-suppressions` | `@ts-ignore` / `@ts-expect-error` comments |
| `type-safety.untyped-form-files` | Files importing `UntypedForm*` |
| `version.end-of-life-packages` | End-of-life packages |
| `version.mismatched-angular-packages` | Angular packages on another major |
| `version.webpack-builders` | Projects on the webpack builder |
