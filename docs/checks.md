# The twelve checks

Every check grades one area **good**, **fair**, **poor** or **info**. `info` means there was nothing to grade (no components, no tests) or an input was missing (no `node_modules`), and it never counts against the score.

The score is the average of the graded areas: good counts 100, fair 60, poor 20.

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

The id in parentheses is what the JSON report uses.

---

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

**What it reads:** the `@deprecated` tags in the installed `@angular/*`, `@ngrx/*` and `rxjs` type definitions, matched against every symbol your code imports from those packages, plus enum members such as `ChangeDetectionStrategy.Default`. Templates are scanned for `*ngIf`, `*ngFor` and `[ngSwitch]`, which no import reveals. On RxJS 7 and later, `.toPromise()` calls are counted too: an instance method no import shows, removed in RxJS 8 in favour of `firstValueFrom` / `lastValueFrom`.

An app that does not use RxJS or NgRx simply has nothing from them to report. The "deprecated two majors ago" rule applies to Angular and NgRx only, whose majors move together; RxJS deprecations are reported but never make the area poor on their own.

There is no hand-kept list. The report shows exactly what the installed version marks, with Angular's own wording and version. A function counts as deprecated only when every overload is, and Angular's private `ɵ` names are ignored.

**Grading**

| Grade | When |
| --- | --- |
| good | nothing deprecated in use |
| fair | deprecated APIs in use, all deprecated less than two majors ago |
| poor | an API deprecated two or more majors before the installed version, which any upgrade may remove |
| info | dependencies are not installed |

On an old version this check only knows what *that* version deprecates. APIs deprecated later show up at each upgrade step, which is what the [version check](#version) is for.

**Fixing it:** each finding quotes Angular's replacement. For templates: `ng generate @angular/core:control-flow`.

---

## Third-party compatibility (`dependencies`) <a id="dependencies"></a>

**What it reads:** the `peerDependencies['@angular/core']` range of every installed package, so any UI kit, state library or utility is covered without a list of known names. Angular's own packages, NgRx and Nx are left out, since `ng update` and `nx migrate` move them. Online, it asks the npm registry for each package's releases: the first one that supports each next Angular major, and whether the package is deprecated.

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
| fair | more eager than lazy routes (with five or more routes), or a file over 1 000 lines |
| poor | ten or more eager routes and none lazy, or three files over 1 000 lines |

Constructor injection and class-based guards are reported as low findings but never change the grade: they work, they are only the older style. `inject()` and functional guards are what current Angular and its migrations produce.

**Fixing it:** `loadComponent: () => import('./x').then((m) => m.X)` per route; `ng generate @angular/core:inject` for constructors; functional guards (`CanActivateFn`) and interceptors (`HttpInterceptorFn` with `withInterceptors`). Large files are split by responsibility, the largest first.

---

## Testing (`testing`) <a id="testing"></a>

**What it reads:** the unit-test runner from the test targets' builders and the dependencies (Karma, Jest, Vitest), spec files, components and services with a `x.spec.ts` next to `x.ts`, Jasmine-only calls (`spyOn`, `jasmine.*`), and the end-to-end setup (Protractor, Playwright, Cypress).

"Has a spec next to it" is a proxy for coverage, not coverage: it needs no test run, which is what lets the tool run on a repository it has never seen.

**Grading**

| Grade | When |
| --- | --- |
| good | a current runner and at least 30% of components and services with a spec |
| fair | under 30% with a spec |
| poor | Karma, Protractor, or no specs at all |

**Fixing it:** the Angular CLI's default runner is Vitest since v21 (`@angular/build:unit-test`). The finding counts the Jasmine-specific calls a move would touch.

---

## Type safety (`type-safety`) <a id="type-safety"></a>

**What it reads:** `strictNullChecks`, `noImplicitAny` and `strict` from the application tsconfig (with `extends` resolved), `strictTemplates` from `angularCompilerOptions`, and the escape hatches: explicit `any` per 1 000 lines, non-null assertions (`x!`), `@ts-ignore` / `@ts-expect-error`, `$any()` in templates and `UntypedForm*` imports.

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

**What it reads:** the places where code steps around Angular's built-in XSS protection, in application files (specs are left out):

- `bypassSecurityTrustHtml`, `…Style`, `…Script`, `…Url`, `…ResourceUrl` calls;
- HTML written straight into the DOM: assignments to `innerHTML` / `outerHTML`, `insertAdjacentHTML`, `document.write`, `Renderer2.setProperty(el, 'innerHTML', …)`;
- strings run as code: `eval` and `new Function`;
- `[innerHTML]` / `[outerHTML]` bindings in templates.

Angular sanitizes every bound value, so an Angular app is safe from cross-site scripting by default. The check counts the escape hatches; it cannot tell a constant from user input, so each finding is a place to review, not a proven hole.

**Grading**

| Grade | When |
| --- | --- |
| good | none of the above, apart from `[innerHTML]` bindings (which Angular sanitizes) |
| fair | `bypassSecurityTrust*` calls: each needs a look at where its value comes from |
| poor | HTML written into the DOM past the sanitizer, or `eval` / `new Function`: these skip sanitization for every value |

**Fixing it:** bind HTML with `[innerHTML]` instead of writing it to the element; sanitize user content with an allow-list sanitizer such as DOMPurify before trusting it; replace `eval` with a lookup table or `JSON.parse`.

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
