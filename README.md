# ng-checkup

[![npm](https://img.shields.io/npm/v/ng-checkup)](https://www.npmjs.com/package/ng-checkup) [![CI](https://github.com/stefankuburovic/ng-checkup/actions/workflows/ci.yml/badge.svg)](https://github.com/stefankuburovic/ng-checkup/actions/workflows/ci.yml)

A one-minute modernization report for any Angular codebase.

Point it at a repository and it tells you how far the code is from current Angular, what will break on the next upgrade, and where the work is: version gap, deprecated APIs, zoneless readiness, standalone and signal adoption, test runner, type safety and circular dependencies. Each area gets a grade, every finding names the files, and the HTML report is a single self-contained page you can hand to a team lead or a client.

```bash
npx ng-checkup
npx ng-checkup path/to/app --report checkup.html
```

Needs Node 22 or newer.

```text
ng-checkup 0.1.0  legacy-app · Angular CLI · Angular ^15.2.0
8 TypeScript files, 1 template, 50 lines of application code, analysed in 32 ms

[POOR]  Angular version & tooling              Angular ^15.2.0, 7 majors behind 22.
[INFO]  Deprecated APIs                        Dependencies are not installed, so deprecations could not be read from the Angular packages.
[FAIR]  Change detection & zoneless readiness  Runs on zone.js; 50% of 2 components use OnPush.
[POOR]  Components & templates                 2 components: 0% standalone, 0% signal inputs, 0% built-in control flow.
[FAIR]  State management                       Classic NgRx in 2 files, 0 signal()/computed() calls, 0 signal-store files.
[POOR]  Testing                                Karma, 1 spec file, 25% of components and services with a spec.
[POOR]  Type safety                            strictNullChecks off, strictTemplates off, 2 explicit any.
[FAIR]  Circular dependencies                  1 group of files importing each other in a loop, 2 files in total.

Score 37/100  Average of the graded areas: good counts 100, fair 60, poor 20. Areas marked info are not counted.

Top priorities
  1. high   Angular 15 is 7 majors behind 22 and out of support (Angular version & tooling)
  2. high   `@angular/flex-layout` is end of life (Angular version & tooling)
  3. high   Unit tests run on Karma, which is deprecated (Testing)
  4. high   End-to-end tests use Protractor, which is end of life (Testing)
  5. high   `strictNullChecks` is off (Type safety)
```

On a real 1 600-file Nx monorepo it finishes in under two seconds.

## What it checks

| Area | What it looks at | Graded on |
| --- | --- | --- |
| **Angular version & tooling** | Installed version against the latest on npm, mixed `@angular/*` majors, webpack vs. esbuild builder, end-of-life packages (`@angular/flex-layout`, Protractor, TSLint, …) | The 18-month support window: the newest three majors are supported |
| **Deprecated APIs** | Every Angular and NgRx symbol the code imports that the **installed** packages tag `@deprecated`, plus `*ngIf` / `*ngFor` / `[ngSwitch]` in templates | `high` once a deprecation is two majors old, the earliest Angular may remove it |
| **Change detection** | Zoneless or zone.js (zoneless is the default from Angular 21), OnPush coverage, `NgZone` usage, zone-only test helpers | Zoneless, or OnPush coverage as the readiness proxy |
| **Components & templates** | Standalone vs. NgModule, signal inputs/outputs vs. decorators, built-in control flow, `@defer` | Average adoption, with the `ng generate` migration for each gap |
| **State management** | Classic NgRx, NgRx signal store, Angular signals, `BehaviorSubject` services | Never `poor`: classic NgRx is supported, the check measures the distance to signals |
| **Testing** | Karma / Jest / Vitest, spec files next to components and services, Protractor / Playwright / Cypress | Karma or Protractor, or no specs at all |
| **Type safety** | `strictNullChecks`, `strictTemplates`, `noImplicitAny`, explicit `any` per 1 000 lines, `x!`, `@ts-ignore`, `$any()`, `UntypedForm*` | The two flags that let the most runtime errors through |
| **Circular dependencies** | Import cycles between application files, through barrels and tsconfig `paths` | Groups of files in a loop, with one concrete loop to cut |

Defaults that changed between versions are applied per version: a component without `standalone` is standalone from Angular 19 and module-based before; one without `changeDetection` is OnPush from 22 and eager before.

## Reports

```bash
npx ng-checkup --report checkup.html   # self-contained page, light and dark, prints to PDF cleanly
npx ng-checkup --report checkup.md     # for a pull request or a wiki
npx ng-checkup --report checkup.json   # everything, machine-readable
npx ng-checkup --verbose               # every finding and file in the terminal
```

`--report` is repeatable. The HTML page loads nothing from the network: no fonts, no scripts, no images.

## In CI

```bash
npx ng-checkup --fail-on poor --report checkup.md
```

Exits with `1` when any area is graded `poor` (or `fair` with `--fail-on fair`), `2` on a usage error, `0` otherwise. Areas graded `info`, the ones the tool could not measure, never fail a run.

## What leaves your machine

One request: the latest `@angular/core` version from the npm registry, with a three-second timeout. `--offline` skips it and compares against the newest major this release knows about, and the report says so. No source, no file names, no telemetry. The tool reads files and never writes anything except the reports you ask for.

## How it works

- **Syntax only.** Every `.ts` file is parsed once with the TypeScript compiler API, without a type checker and without building the project. That is what makes it fast and lets it run on a repository whose dependencies are not installed. Identifiers are matched through their imports, so a local helper called `signal` is not counted as Angular's.
- **Deprecations come from your `node_modules`.** The tool reads the `@deprecated` tags in the installed `@angular/*` and `@ngrx/*` type definitions, following Angular's re-exports between its bundled `.d.ts` chunks, so the report always matches the version you actually run, with Angular's own wording. A function counts as deprecated only when every overload is.
- **Cycles are counted as groups.** A strongly connected component is one thing to untangle; counting individual cycles grows combinatorially and produces numbers nobody can act on. `import type` and `import()` are ignored, since neither can cause an initialization-order crash.

## Limitations

- It is static analysis. "Has a spec next to it" is a proxy for coverage, not coverage.
- A monorepo with several apps is reported as one codebase.
- No bundle-size analysis yet.

## Roadmap

- Bundle size and eager-chunk analysis from the build's `stats.json`
- Per-project breakdown for Nx and multi-project CLI workspaces
- An effort estimate per finding, in days
- Ratchet mode: store a baseline and fail CI only when a number goes up

## Development

```bash
npm install
npm test          # builds, then runs the Vitest suite against the fixture apps in test/fixtures
npm run typecheck
```

## License

MIT
