# The eight checks

Every check grades one area **good**, **fair**, **poor** or **info**. `info` means there was nothing to grade (no components, no tests) or an input was missing (no `node_modules`), and it never counts against the score.

The score is the average of the graded areas: good counts 100, fair 60, poor 20.

- [Angular version & tooling](#version)
- [Deprecated APIs](#deprecated-apis)
- [Change detection & zoneless readiness](#change-detection)
- [Components & templates](#components)
- [State management](#state)
- [Testing](#testing)
- [Type safety](#type-safety)
- [Circular dependencies](#circular-deps)

The id in parentheses is what the JSON report uses.

---

## Angular version & tooling (`version`) <a id="version"></a>

**What it reads:** the installed `@angular/core` version (the `package.json` range when dependencies are not installed), the latest version on npm, every `@angular/*` package's major, the build targets in `angular.json` or the Nx `project.json` files, and a short list of end-of-life packages.

**Grading**

| Grade | When |
| --- | --- |
| good | on the latest major or one behind |
| fair | two majors behind, a webpack-based builder, mixed `@angular/*` majors, or end-of-life tooling (Protractor, TSLint, codelyzer, node-sass) |
| poor | three or more majors behind (out of support), or an end-of-life runtime package (`@angular/http`, `@angular/flex-layout`) |

Angular releases a major roughly every six months and supports each for 18 months, so the newest three are supported. `ng update` moves one major at a time, so the gap is also the number of upgrade steps.

**Fixing it:** `ng update @angular/core@<next> @angular/cli@<next>`, one major at a time, reviewing each step's migrations. For the builder: `ng update @angular/cli --name use-application-builder`.

---

## Deprecated APIs (`deprecated-apis`) <a id="deprecated-apis"></a>

**What it reads:** the `@deprecated` tags in the installed `@angular/*` and `@ngrx/*` type definitions, matched against every symbol your code imports from those packages, plus enum members such as `ChangeDetectionStrategy.Default`. Templates are scanned for `*ngIf`, `*ngFor` and `[ngSwitch]`, which no import reveals.

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

**Fixing it:** in a large codebase, stage it: a separate tsconfig that checks one folder at a time, and a count in CI that may only go down.

---

## Circular dependencies (`circular-deps`) <a id="circular-deps"></a>

**What it reads:** every static, value-level import between application files, resolved like the Angular CLI does (relative paths, `index.ts` barrels and tsconfig `paths` aliases). `import type` and `import()` are ignored, since neither can cause an initialization-order crash, and so are spec files.

Cycles are reported as **groups** of files that import each other in a loop (strongly connected components), each with one concrete loop to cut. Counting individual cycles grows combinatorially and gives numbers nobody can act on.

**Grading**

| Grade | When |
| --- | --- |
| good | no cycles |
| fair | up to three groups with ten files in total |
| poor | more than that |

**Fixing it:** most loops close through a barrel import that drags in a sibling. Importing the file directly instead of `./index` usually breaks it.
