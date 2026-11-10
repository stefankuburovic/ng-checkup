# The checks

Fifteen checks run on every repository, twelve of them graded; [Translations](#translations), [Accessibility](#accessibility) and [SSR & hydration](#ssr) only report. A sixteenth runs first when there is legacy code: [AngularJS migration](#angularjs) for AngularJS code or packages, or, for an Ex Libris Primo VE customization package, [Primo NDE migration](#primo-nde) in its place. [Custom rules](#rules) appear last when the config has rules, and only report.

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
- [Translations](#translations) (listed, never graded)
- [Accessibility](#accessibility) (listed, never graded)
- [SSR & hydration](#ssr) (listed, never graded)
- [Circular dependencies](#circular-deps)
- [Bundle size](#bundle)
- [Custom rules](#rules) (only with rules in the config, never graded)

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

**Outside the grade:**

- *Production build settings* (`production-build-issues`): the `production` configuration of each application's `build` target, laid over its options, as `ng build` reads them. Only what is written counts, except `outputHashing`, which defaults to `none`: `optimization: false` and `aot: false` (medium), `buildOptimizer: false` on the webpack builder, `sourceMap` on without `hidden: true`, no `budgets`, and `outputHashing` other than `all` or `bundles` (low). An application without a `production` configuration says nothing, since what its build uses cannot be told. Source maps are not called a mistake: the finding shows how to keep them for an error tracker and off the server.
- *Packages in more than one major* (`duplicate-packages`): `rxjs`, `zone.js`, Angular's runtime packages and NgRx locked in two majors anywhere in the tree, from `package-lock.json` or `yarn.lock`, without installing anything. Only what reaches the app counts: npm marks what development needs, and in `yarn.lock` the tree is walked from the `dependencies` of `package.json`. A `pnpm-lock.yaml` is not read, since it does not say what only development needs. Two `rxjs` majors are two copies in the bundle and an `Observable` that is not one to the other.

On the corpus: the source maps, budgets and file names of beaconchain-app, the source maps of ionic-conference-app (set in the options, which production inherits), and airgap-wallet's `rxjs` 6, which Ledger's libraries pull into the app beside its own 7. An Nx example's `rxjs` 6, which only a CLI prompt library uses, is left out.

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

**What it reads:** standalone vs. NgModule-declared components (standalone is the default from Angular 19), `input()` / `model()` / `output()` vs. `@Input()` / `@Output()`, built-in control flow (`@if`, `@for`, `@switch`) vs. structural directives, `@defer` blocks, and manual `.subscribe()` calls in components and directives: state moved by hand, where `toSignal()` or the `async` pipe would let Angular own the subscription. A subscription counts as tied to the component's lifetime when `takeUntilDestroyed`, `takeUntil`, `take` or `first` is in its chain. The count is a low finding and a baseline measure, not part of the grade: it is the number a move to signals should watch fall, in `ng-checkup history` too.

**Colour literals outside the design tokens** are a low finding and the measure `hardcoded-colors`: `#fff`, `rgb()`/`rgba()`/`hsl()`/`hsla()` and the common named colours in a colour declaration (`color`, `background`, `border`, `fill`, `box-shadow`, ...) of any `.css`, `.scss`, `.sass` or `.less` file, and in inline `style="..."` attributes and `[style.x]="'...'"` bindings. A theme changes the tokens; a colour written into a rule does not change with it and shows up wrong in dark mode or another brand. The value of a custom property (`--brand: #0b5`) or of a SCSS/Less variable is a token definition and not counted, files named for the tokens (`_tokens.scss`, `variables.less`, `theme.css`, `palette.scss`, `colors.scss`) are skipped, and so are comments, `transition` values and anything inside `url(...)`. On the corpus: 0 to 89 per repository.

**Subscriptions nothing ends** are a finding and a measure of their own (`unended-subscriptions`): no `takeUntilDestroyed`, `takeUntil`, `take`, `first` or `takeWhile` in the chain, no cleanup anywhere in the class (`ngOnDestroy`, `unsubscribe()`, `DestroyRef`, `Subscription.add`), and a source that outlives the component. Sources that complete or die with the component are left out: `HttpClient`, `ActivatedRoute`, a form's `valueChanges`, a dialog's close event, `translate.get()`, and a `Subject` or `EventEmitter` the class creates itself. A service call that completes after one value cannot be told from one that never completes, so the finding is low and the count is an upper bound. On the corpus it lists 0 to 25 per repository; a codebase that already guards every component file (one with a `check-subscriptions` script, say) reads 0.

**Template speed** is four low findings and measures, outside the grade: what a template makes change detection repeat. A template is read only when a component class in application code owns it, through `templateUrl` or an inline `template`, and a template several classes share needs all of them to agree, so a rule in doubt says nothing.

- *`*ngFor` without `trackBy`* (`untracked-ngfor`): `*ngFor` or `[ngForOf]` with no `trackBy`. A list rebuilt from new objects recreates every row. A list of strings or numbers is fine as it is and cannot be told from the template, so the count is an upper bound.
- *`@for` with `track $index`* (`track-by-index`), the variable it was renamed to included: state in the DOM or a child stays at the position when items move. Harmless on a list that never changes order, which the code cannot always show.
- *Method calls in template bindings* (`template-method-calls`): a call of a method the class itself declares, or a field holding a function, in an interpolation, property binding, structural directive, block condition or `@let`. Signals (`signal`, `computed`, `input`, ...) are not methods and are not counted, nor are event handlers, `track` expressions, calls on another object (`form.get('x')`), template variables, getters or inherited methods. A cheap read costs nothing, so this is the list to look through, not to empty.
- *Impure pipes* (`impure-pipes`): `pure: false` on a pipe this repository declares and a template uses. Some pipes need it, `push` from rx-angular for one.

A literal array, and a field of the class that keeps the same items (a non-empty array literal nothing in the class writes to or mutates, or a `readonly` field holding a named constant), is left out of both loop rules. On the corpus, per repository: 0 to 80 `*ngFor`, 0 to 12 `track $index`, 0 to 41 method calls, 0 to 2 impure pipes.

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

**What it reads:** route objects (`{ path, component }` is eager, `{ path, loadComponent }` or `{ path, loadChildren }` is lazy), the import graph and the tags and pipes templates use (for dead code), file sizes in lines of code (lines a token of the program touches: blank lines and comment-only lines do not count, so documenting a file does not make it large), constructors of components, directives, pipes and services, and classes implementing a router guard or resolver interface or `HttpInterceptor`.

A `component:` route counts as eager only in a file the app loads at startup: everything statically reachable from the build target's `main.ts`. In a module that is itself behind `loadChildren`, the route loads with that module and counts as lazy.

**Grading**

| Grade | When |
| --- | --- |
| good | most routes are lazy and no file is over 1 000 lines |
| fair | more eager than lazy routes (with five or more routes), or a file over 1 000 lines (file size alone never makes the area poor: long files are a refactoring list, the hotspots below say which first) |
| poor | ten or more eager routes and none lazy |

Constructor injection and class-based guards are reported as low findings but never change the grade: they work, they are only the older style. `inject()` and functional guards are what current Angular and its migrations produce.

**Hotspots.** In a git repository with its history, the check also reads how often each file changed in the last twelve months (`git log`, merges left out, limited to the analysed folder). A file of at least 300 lines changed in at least 10 commits is a hotspot, ranked by lines times commits, and the five worst are listed: that is where a refactoring pays off first, since the file is read and edited all the time. Hotspots never change the grade and are not a baseline measure, because the count moves with how busy the team is, not with the code. In a shallow clone (`fetch-depth: 1` in CI, a remote repository argument) there is one commit of history, and the report says so instead of ranking nothing.

**Dead code.** Two low findings, each with a baseline measure, that never change the grade (dead code costs reading time, not load time):

- *Files nothing imports* (`unused-files`): application files no other file imports in any way (a value or a type, eagerly, through `import()`, from a spec, through `new Worker(new URL('./x.worker', import.meta.url))`, or as an Angular 7 string `loadChildren: 'app/x/x.module#XModule'`), that no build target or tsconfig names (`browser`, `main`, `server`, `polyfills`, `fileReplacements`, a tsconfig's `files`), and that are no library entry (`ng-package.json`, a project `package.json`'s `exports`, a tsconfig `paths` target). Only files inside the `sourceRoot` of a project that uses Angular are candidates, so scripts next to `angular.json` and the React or e2e projects of an Nx workspace are never listed; `main.ts`, `polyfills.ts`, `test.ts`, environment files, `public-api.ts`, configs, stories and e2e folders are left out by name. It is one level deep on purpose: a file only another unused file imports is listed on the next run, after the first is deleted.
- *Components and pipes no template uses* (`unused-components`, `unused-pipes`): a component whose tag appears in no template (external, inline or `index.html`; HTML comments do not count) and whose class no file names outside the `declarations`, `imports` and `exports` arrays of Angular metadata, and a pipe no template calls by name and no file names. A route's `component:`, `loadComponent`'s `m.X`, `dialog.open(X)`, `bootstrap: [X]`, `inject(XPipe)` and `providers: [XPipe]` all count as uses; being declared in an NgModule or listed in a standalone `imports` array does not, since Angular itself reports such an import as unused. Only components whose selector is a plain tag (`app-hero`, `amount`, or several tags separated by commas) are judged here. Selectors with a class or `:not(...)`, declarables without a selector, default exports and everything in a library project are never judged, because a template cannot settle them. A file already listed as unimported is not listed again here.
- *Directives and attribute selectors no template matches* (`unused-attribute-selectors`), only with `--attribute-selectors` (or `"attributeSelectors": true` in the config): directives, and components whose selector names an attribute (`[appTooltip]`, `button[mat-button]`). A selector part matches when a template has its tag, if it names one, and its attributes: `[appTooltip]` is matched by `appTooltip`, `[appTooltip]="x"`, `*appTooltip` or an output binding `(appTooltip)="go()"` (Angular matches selectors against inputs and outputs alike); `#appTooltip`, `let-` variables and `[attr.x]`, `[class.x]`, `[style.x]` bindings match nothing. `hostDirectives: [X]` and a query by class count as uses. It is opt-in because an attribute is looser evidence than a tag: whether the tag and the attribute sit on the same element is not checked, which can only call an unused selector used, but a hit is worth a look before it is deleted. Its own measure keeps a baseline taken without the flag undisturbed.
- *Inputs and outputs no template binds* (`unused-inputs`, `unused-outputs`), also only with `--attribute-selectors`: the inputs and outputs of the used components and directives, by the name a template binds (the alias when there is one), from decorators, the signal functions (`input`, `input.required`, `model`, `output`, `outputFromObservable`) and the metadata's `inputs`/`outputs` arrays. An input is bound by a plain attribute (`label="Save"`), a property binding, a two-way binding, or code that sets it by name (`setInput('label', x)`, `inputBinding('label', ...)`, an Ionic `componentProps: { label: x }`); an output by an event binding or `outputBinding`; a `model()` by either of its names. Names are compared across the whole repository, not per element, so an input called `value` counts as bound when any template binds a `value`: the list can miss unused ones, never call a bound one unused. The typical hit is an input with a default that no caller ever sets. When the router binds inputs from the URL (`withComponentInputBinding()`, `bindToComponentInputs`), component inputs are not judged; inputs set through `ngComponentOutletInputs` are not seen.

A file or class loaded in a way the analysis cannot see (a path built at runtime, an element created with `document.createElement`) shows up as unused: leave it out with `ignore` in `ng-checkup.config.json`.

**Fixing it:** `loadComponent: () => import('./x').then((m) => m.X)` per route; `ng generate @angular/core:inject` for constructors; functional guards (`CanActivateFn`) and interceptors (`HttpInterceptorFn` with `withInterceptors`). Large files are split by responsibility, the largest first. Unused files and classes are deleted; the next run lists what they alone used.

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

**Test quality.** Three patterns that let a spec pass while checking nothing are findings and measures of their own, none part of the grade, since each is read from the syntax and errs towards silence:

- **Tests that assert nothing** (`tests-without-assertions`, medium): an `it` / `test` body that calls no `expect`, no `expect*` / `assert*` / `verify*` / `check*` / `should*` helper, no function of the same file that asserts, no namespace assertion (`expect.element`, `assert.equal`), no `@ts-expect-error` (a type test asserts at compile time) and no Cypress command. `xit`, `.skip` and `.todo` are not counted.
- **Assertions in a subscribe the test does not wait for** (`unawaited-subscribe-assertions`, low): the `expect` sits in a `.subscribe()` callback and the test takes no `done`, returns nothing (a test that returns a promise, such as `() => new Promise((done) => ...)`, is awaited by the runner), runs in no `fakeAsync` / `waitForAsync`, awaits nothing and flushes nothing (`flush`, `tick`, `expectOne`, `whenStable`, fake timers, `testScheduler.run`). With an asynchronous source the test ends first and passes without asserting; a synchronous one runs it, which the syntax cannot show.
- **Spec files with `NO_ERRORS_SCHEMA` or `CUSTOM_ELEMENTS_SCHEMA`** (`schema-suppressed-specs`, low): a misspelt input or a component missing from `imports` passes; in `configureTestingModule` neither even applies to a standalone component's own template.

Zone-based helpers in a zoneless app (`fakeAsync`, `waitForAsync`) are counted by [change detection](#change-detection) already. On the corpus: 3 empty tests and 16 unwaited assertions in rx-angular, 0 to 3 elsewhere.

**Fixing it:** the Angular CLI's default runner is Vitest since v21 (`@angular/build:unit-test`). The finding counts the Jasmine-specific calls a move would touch. For a subscribe, `expect(await firstValueFrom(source$))` asserts whether the source is synchronous or not.

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

## Translations (`translations`) <a id="translations"></a>

**What it reads:** with `@ngx-translate/core`, `@jsverse/transloco` or `@ngneat/transloco` among the dependencies, every JSON bundle named after a language below an `i18n`, `l10n`, `locale(s)`, `translations` or `lang(s)` folder (`src/assets/i18n/de.json`, `public/i18n/modules/orders/en.json`), merged deeply per language, since apps that load a core bundle and one per feature declare the same namespace in several files. Transloco bundles in a subfolder are scopes and answer under the folder's name (`i18n/admin/en.json` answers `admin.title`). Against them it judges every literal key: `'a.b' | translate` / `| transloco` with either quote, `translate="a.b"`, `[translate]="'a.b'"`, `t('a.b')` in a `*transloco="let t"` block without `read:`, and `instant` / `get` / `stream` / `translate` / `selectTranslate` calls on a receiver named like a translation service, plus `marker('a.b')`. A key built from data (`item.state | translate`, `'status.' + x | translate`) is not judged, and neither is a key in a spec. Lookups follow ngx-translate's rule that a property may hold a dot in its own name (`"cannot_delete.header"`).

A key is **missing** when some language has no string under it while that language knows the key's first segment, or another language has the key: a typo, a key under the wrong namespace, or a string added to one language only. A key whose first segment no bundle of any language has is listed apart and not graded, because a library's own bundle or a loader that reads the backend may supply it.

**Why it matters:** both libraries render the key itself when a lookup fails, so the user reads `orders.cannot_delete` where a sentence should be, and neither the compiler nor a test that renders the template notices.

**Grading:** none. The area is always `info` and never counts towards the score, so adding it changed no score: the other areas grade how current and safe the code is, and as a graded area every app with complete bundles would gain a free 100. The finding is medium, and the measure `translations.missing-keys` sits in the baseline, so `--fail-on regression` fails on every key that goes missing. Without a translation library or a bundle to judge against (strings from the backend or from TypeScript files) there is no measure. Keys in test code, inline templates of test hosts included, are not judged.

On the corpus, airgap-wallet has 5 (`walletconnect.error` where the bundle has `walletconnect.connection_error`, and three keys only English has).

**Fixing it:** add the string to every language's bundle, or point the template at the key that exists. A key under the wrong namespace looks identical to a missing one, so check the namespace first.

---

**Angular's built-in i18n** (`$localize`, the `i18n` attribute) is read beside the libraries, when a project's `i18n.locales` in `angular.json` or `project.json` names translation files: XLIFF 1.2 and 2.0, Angular's JSON and ARB. Each locale is compared with the source file `ng extract-i18n` writes, found from the `outputPath` and `outFile` of the `extract-i18n` target, else beside a translation file (`messages.de.xlf` gives `messages.xlf`), else in the default places.

- *Messages without a translation* (`i18n-missing`, medium): in the source file, and absent or empty in a locale. Counted once per message and locale. Angular falls back to the source text and by default the build only warns.
- *Translations marked as not done* (`i18n-not-done`, low): state `new` or `needs-translation` (`initial` in 2.0), and the target is still the source text, as merge tools leave it. A different text under such a state was translated by someone who kept the state, and is left out.
- *Obsolete translations* (`i18n-obsolete`, low): in a locale, and no longer in the source file.

The comparison runs on the source file and not on the code, since an id without `@@` is a hash of the message. That file can be out of date, and the findings say so: run `ng extract-i18n` first. Without a source file only the states are read, and an info finding says what was not compared. A file that is missing or in a format this does not read (XMB and XTB) is listed, never treated as empty. On public repositories, the counts of missing and obsolete translations matched an independent count across 70 locales of three repositories (PeerTube, rclone-webui-angular, angular-example-app). The corpus covers it with rclone-webui-angular: 52 missing, 49 not done and 52 obsolete across 29 locales, each count matched by an XML parser.

## Accessibility (`accessibility`) <a id="accessibility"></a>

**What it reads:** every template, external or inline (test code left out), with a small tag scanner, for five defects WCAG level A names and the European Accessibility Act asks to fix:

| Measure | What | WCAG |
| --- | --- | --- |
| `unlabelled-controls` (medium) | `<input>`, `<select>`, `<textarea>` with no `<label for>` matching its `id`, no wrapping `<label>`, `<mat-form-field>` or other `*-form-field`, no `aria-label`, `aria-labelledby`, `title` or `placeholder` | 1.3.1, 4.1.2 |
| `unnamed-buttons` (medium) | `<button>` with no text, interpolation, image with `alt`, projected content or `aria-label` / `aria-labelledby` / `title` | 4.1.2 |
| `click-without-keyboard` (medium) | `(click)` on a `div`, `span`, `li`, `td`, `img`, `mat-icon` and other non-interactive elements with no `(keydown)` / `(keyup)` / `(keypress)` handler | 2.1.1 |
| `images-without-alt` (medium) | `<img>` with no `alt`, static or bound, unless `aria-hidden="true"` or `role="presentation"` | 1.1.1 |
| `positive-tabindex` (low) | `tabindex` above 0 | 2.4.3 |

Every attribute counts in Angular's spellings (`alt`, `[alt]`, `[attr.alt]`), commented-out markup is not judged, and a bound `[id]` beside a bound `[for]` counts as labelled. What a directive or a component supplies at runtime is not seen, so the rules err towards silence: an icon ligature (`<mat-icon>delete</mat-icon>`) counts as a button's text.

**Grading:** none, as for translations: always `info`, so it changes no score, and the measures sit in the baseline, so `--fail-on regression` fails on a new defect. On the corpus every repository but one has some; the commonest are `(click)` on a `div` and images without `alt`, and one storefront's password fields have a `<label for>` that points at an input without the `id`.

**Fixing it:** a `<button>` for anything clickable, `<label for>` or `<mat-form-field>` around every control, `alt` on every image (`alt=""` for decoration), `aria-label` on icon-only buttons, and `tabindex` of `0` or `-1` only.

---

## SSR & hydration (`ssr`) <a id="ssr"></a>

**When it runs:** only in a project that renders on the server: `@angular/ssr` or `@nguniversal/*` in `package.json`, a `provideServerRendering()` call, a `server` target, or the `server`, `ssr` or `outputMode: "server"` options of the build target. Without one every `window` would be noise, so the area says it does not apply and has no measures. In a workspace of several projects only the ones that say they render on the server are read, since a shared library may or may not run there.

**What it reads:** code known to run during rendering, from the syntax: a module's top level (not `main.ts`, which only runs in the browser), the fields and constructor of a component, directive, pipe or service, the lifecycle hooks of a component or directive, and the class's own methods those call through `this`.

- *Browser globals* (`browser-globals`, medium): `window`, `document`, `localStorage`, `sessionStorage` and `navigator` that resolve to no local name. `document` from `const document = inject(DOCUMENT)` or a constructor parameter is the injected one, not the global, and `this.document` and types do not count. On the server these names do not exist, so the render stops with a ReferenceError.
- *Native DOM changes* (`dom-mutations`, low): assigning `innerHTML` or `outerHTML`, and `appendChild` and similar on a `nativeElement`, which end in a hydration mismatch.
- *`ngSkipHydration`* (`skip-hydration`, low): in templates and `host` metadata. The documented way out, so a debt rather than a defect.
- *Hydration not on* (`missing-hydration`, medium): no `provideClientHydration()` in an app with a build entry, on Angular 16 or newer.

**What stays silent:** a guard (`isPlatformBrowser`, `isPlatformServer`, `typeof window`, a condition naming `browser`, `server` or `platform`, an earlier `if` of that kind, a `try`), a method called under a guard, a callback or nested function (`afterNextRender`, `setTimeout`, a subscription), which may run later, and a click handler nothing on the server calls. It also cannot see routes set to `RenderMode.Client`, whose code does not run on the server. So a count of 0 does not prove a page renders; a hit is worth reading.

**Grading:** none. Always `info`, so it changes no score; the measures sit in the baseline, so `--fail-on regression` fails on a new one.

**Checked on:** the SSR apps of the corpus, where every hit was read by hand: vendure-storefront and rx-angular (0 hits, all guarded or in callbacks), TypeFast (an `appendChild` in `ngOnInit`, one `ngSkipHydration`; its `localStorage` read sits behind `isBrowser` and stays silent), dattebayo (a `document` listener its directive's constructor adds) and ng-nest-admin (hydration commented out, a `removeChild` in `ngOnInit`, ten `ngSkipHydration`). Six more public SSR repositories gave 0 hits.

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

**Heavy packages** are read with or without a stats file and never touch the grade: a short list kept by hand, `moment`, whole `lodash`, `rxjs-compat` and `jquery`, each with its lighter way out. Without a stats file a package counts when a file that loads at startup imports it for its code, or when the build target loads it through `scripts`, and the low finding gives no size. A dynamic `import()`, a file only lazy routes reach, a type-only import, `lodash/debounce`, `inject: false` and a package `package.json` lists but nothing imports all stay out. With a stats file the finding is medium and gives the real size in the initial bundle, and also names a listed package only another package pulls in (`lodash` from 50 kB, since a few of its functions are the fix). No saving is given, because it depends on what replaces the package. The measure `heavy-packages` counts only what the code and the build configuration state, so it reads the same with a stats file and without one, and it is left out when the workspace names no entry. On the corpus: `moment` and `lodash` in airgap-wallet, `lodash` in go-data, none elsewhere.

**Fixing it:** lazy routes and `@defer` for screens and heavy widgets; replace or lazy-load the largest packages the report lists.

---

## Custom rules (`rules`) <a id="rules"></a>

**When it runs:** only when the config has `rules`, in `ng-checkup.config.json` or `--config-json`. Without them the area is not in the report.

**What it reads:** each rule is one of two kinds.

- `forbidImport`: package or path specifiers no file may import. `moment` also forbids `moment/locale/de`, not `moment-timezone`. Static imports, `import()`, `require` and `export … from` count; `import type` does not, since it loads nothing.
- `pattern`: a regular expression tested on every line of TypeScript files, templates and stylesheets, comments included. It reads text, not code, so `console\.log` also matches a commented-out line.

By default a rule reads application code: no specs, e2e or mock files, and no generated files. With `files` it reads the paths named there, in the `ignore` syntax, test code included, so a rule can forbid `fdescribe` in `**/*.spec.ts`.

**What it reports:** one finding per broken rule, at the rule's `severity` (default `medium`), with its `message` and every place. One measure per rule, `rules.<id>`, broken or not, so the baseline holds a 0 and `--fail-on regression` fails on the first violation of a rule that had none.

**Why not ESLint:** `no-restricted-imports` and `no-restricted-syntax` forbid the same things, but fail on every old violation, so in a legacy codebase the rule tends to be switched off. Here the old violations are recorded, and only a new one fails.

**Limits:** a pattern that takes longer than two seconds on one file stops the run and names the rule and the file; that is a pattern that backtracks without end, such as `(a+)+b`. An invalid rule stops the run before anything is read, as an unknown config key does.

**Grading:** none. Always `info`, so it changes no score.

---

## Measures recorded by the baseline <a id="measures"></a>

`ng-checkup baseline` records these counts in `ng-checkup.baseline.json`, and `--fail-on regression` fails when any of them goes up. Lower is better for every one. The number of majors behind is deliberately not a measure: it grows when Angular ships a release, not when the code gets worse. Neither is bundle size, which grows with every feature.

| Key | Counts |
| --- | --- |
| `accessibility.click-without-keyboard` | Click handlers on non-interactive elements without a key handler |
| `accessibility.images-without-alt` | Images without alt |
| `accessibility.positive-tabindex` | `tabindex` above 0 |
| `accessibility.unlabelled-controls` | Form controls without a label |
| `accessibility.unnamed-buttons` | Buttons without a name |
| `angularjs.angularjs-components` | AngularJS components, directives and controllers |
| `angularjs.angularjs-controllers` | AngularJS controllers |
| `angularjs.angularjs-filters` | AngularJS filters |
| `angularjs.angularjs-services` | AngularJS services, factories and providers |
| `angularjs.angularjs-templates` | Templates with AngularJS syntax |
| `angularjs.scope-files` | Files using `$scope` |
| `architecture.class-guards` | Class-based guards and interceptors |
| `architecture.constructor-injection` | Classes with constructor injection |
| `architecture.eager-routes` | Eagerly loaded routes (in files loaded at startup) |
| `architecture.unused-attribute-selectors` | Directives and attribute selectors no template matches (only with `--attribute-selectors`) |
| `architecture.unused-components` | Components no template uses |
| `architecture.unused-files` | Files nothing imports |
| `architecture.unused-inputs` | Inputs no template binds (only with `--attribute-selectors`) |
| `architecture.unused-outputs` | Outputs no template binds (only with `--attribute-selectors`) |
| `architecture.unused-pipes` | Pipes no template uses |
| `architecture.very-large-files` | Files over 1000 lines |
| `change-detection.eager-components` | Components with eager change detection |
| `change-detection.ngzone-files` | Files injecting NgZone |
| `change-detection.zone-test-helpers` | Zone-based test helper calls |
| `bundle.heavy-packages` | Heavy packages loaded at startup |
| `ssr.browser-globals` | Browser globals in code that runs on the server |
| `ssr.dom-mutations` | Native DOM changes in code that runs during rendering |
| `ssr.missing-hydration` | Server rendering without `provideClientHydration` |
| `ssr.skip-hydration` | Uses of `ngSkipHydration` |
| `circular-deps.files-in-cycles` | Files in import cycles |
| `components.decorator-inputs-outputs` | `@Input()` / `@Output()` decorators |
| `components.hardcoded-colors` | Colour literals outside the design tokens |
| `components.impure-pipes` | Impure pipes |
| `components.legacy-control-flow` | `*ngIf` / `*ngFor` / `[ngSwitch]` uses |
| `components.manual-subscriptions` | Manual `.subscribe()` in components and directives |
| `components.module-components` | Components declared in NgModules |
| `components.template-method-calls` | Method calls in template bindings |
| `components.track-by-index` | `@for` with `track $index` |
| `components.unended-subscriptions` | `.subscribe()` in components and directives that nothing ends |
| `components.untracked-ngfor` | `*ngFor` without `trackBy` |
| `dependencies.deprecated-packages` | Packages deprecated on npm |
| `dependencies.peer-mismatches` | Packages that do not accept the installed Angular |
| `deprecated-apis.deprecated-usages` | Deprecated API uses (symbol × file) |
| `deprecated-apis.legacy-template-directives` | `*ngIf` / `*ngFor` / `[ngSwitch]` uses |
| `deprecated-apis.to-promise-calls` | `.toPromise()` calls |
| `primo-nde.parentctrl-reads` | Reads of `parentCtrl` in a Primo VE package |
| `primo-nde.primo-helper-components` | Helper components of a Primo VE package |
| `primo-nde.primo-hooks` | Primo hooks filled, per view |
| `primo-nde.primo-integrations` | Third-party integrations in a Primo VE package |
| `security.dynamic-code` | `eval` and `new Function` calls |
| `security.inner-html-bindings` | `[innerHTML]` bindings |
| `security.sanitizer-bypasses` | `bypassSecurityTrust*` calls |
| `security.unsafe-dom-writes` | Direct DOM HTML writes |
| `state.behaviorsubject-services` | Services holding state in a `BehaviorSubject` |
| `state.classic-ngrx-files` | Files on classic NgRx |
| `state.effect-decorators` | Removed `@Effect()` decorators |
| `rules.<id>` | Places that break the config's rule `<id>` |
| `testing.schema-suppressed-specs` | Spec files with `NO_ERRORS_SCHEMA` or `CUSTOM_ELEMENTS_SCHEMA` |
| `testing.tests-without-assertions` | Tests that assert nothing |
| `testing.unawaited-subscribe-assertions` | Assertions in a subscribe the test does not wait for |
| `testing.untested-files` | Components and services without a spec |
| `translations.i18n-missing` | Messages without a translation |
| `translations.i18n-not-done` | Translations marked as not done |
| `translations.i18n-obsolete` | Translations of messages no longer in the source file |
| `translations.missing-keys` | Translation keys that resolve to no string |
| `type-safety.explicit-any` | Explicit `any` in application code |
| `type-safety.non-null-assertions` | Non-null assertions (`x!`) |
| `type-safety.strict-flags-off` | `strictNullChecks` / `strictTemplates` / `noImplicitAny` off |
| `type-safety.template-any-casts` | `$any()` casts in templates |
| `type-safety.ts-suppressions` | `@ts-ignore` / `@ts-expect-error` comments |
| `type-safety.untyped-form-files` | Files importing `UntypedForm*` |
| `version.duplicate-packages` | Runtime packages locked in more than one major |
| `version.end-of-life-packages` | End-of-life packages |
| `version.mismatched-angular-packages` | Angular packages on another major |
| `version.production-build-issues` | Production build settings that cost users |
| `version.webpack-builders` | Projects on the webpack builder |
