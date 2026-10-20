# ng-checkup

[![npm](https://img.shields.io/npm/v/ng-checkup)](https://www.npmjs.com/package/ng-checkup) [![CI](https://github.com/stefankuburovic/ng-checkup/actions/workflows/ci.yml/badge.svg)](https://github.com/stefankuburovic/ng-checkup/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/stefankuburovic/ng-checkup/blob/main/LICENSE)

**A one-minute modernization report for any Angular codebase.**

Point it at a repository and it tells you how far the code is from current Angular, what will break on the next upgrade, and where the work is. Twelve areas get a grade, from the Angular version and third-party packages to security and bundle size, every finding names the files, and the HTML report is one self-contained page you can hand to your team lead.

```bash
npx ng-checkup
```

![ng-checkup in a terminal](https://raw.githubusercontent.com/stefankuburovic/ng-checkup/main/docs/terminal.png)

**[See a full example report →](https://stefankuburovic.github.io/ng-checkup/example.html)** (the Angular 12 version of the RealWorld example app)

---

## Contents

- [Quick start](#quick-start)
- [Set it up in a project](#set-it-up-in-a-project)
- [Configuration](#configuration)
- [Baseline: adopt it on legacy code](#baseline-adopt-it-on-legacy-code)
- [Watch mode](#watch-mode)
- [Upgrade plan](#upgrade-plan)
- [Monorepos](#monorepos)
- [What it checks](#what-it-checks)
- [Reports](#reports)
- [In CI](#in-ci)
- [Programmatic API](#programmatic-api)
- [What leaves your machine](#what-leaves-your-machine)
- [How it works](#how-it-works)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)

## Quick start

Run it in the root of an Angular CLI or Nx workspace. It needs Node 22 or newer and nothing else; your project does not have to build.

```bash
# 1. The summary in your terminal
npx ng-checkup

# 2. The full report as a page to share
npx ng-checkup --report checkup.html

# 3. Record today's numbers, then fail CI only when one gets worse
npx ng-checkup baseline
npx ng-checkup --fail-on regression
```

Install dependencies first (`npm install`) if you can: the deprecated-API check reads the installed Angular packages, and without them it is skipped.

## Set it up in a project

To keep the checkup in the project, with a script, a config file and a CI step:

```bash
ng add ng-checkup        # Angular CLI: installs it and asks which CI to use
# or
npx ng-checkup init      # any workspace, including Nx
```

Both make the same changes and list what they changed:

| File | Change |
| --- | --- |
| `package.json` | a `"checkup": "ng-checkup"` script, and `ng-checkup` in `devDependencies` (`init` only; `ng add` installs it itself) |
| `ng-checkup.config.json` | writes `checkup.html` on every run, and an empty `ignore` list |
| `.gitignore` | the generated reports, if the repository has a `.gitignore` |
| `ng-checkup.baseline.json` | today's numbers, so CI fails only when one gets worse ([baseline](#baseline-adopt-it-on-legacy-code)) |
| `.github/workflows/ng-checkup.yml` | runs on every pull request with `--fail-on regression`, uploads the reports (when `.github/` exists) |
| `ng-checkup.gitlab-ci.yml` | the same as a GitLab job; add `include: [{ local: ng-checkup.gitlab-ci.yml }]` to your `.gitlab-ci.yml` (when that file exists) |

After that it is `npm run checkup` (or `pnpm checkup`, `yarn checkup`; the lockfile decides). Running either command again changes nothing. It never overwrites a file you wrote: an existing workflow or config is kept, and a different `checkup` script is kept unless you pass `--force`.

```bash
npx ng-checkup init --dry-run      # show the changes, write nothing
npx ng-checkup init --ci gitlab    # pick the CI instead of detecting it (github, gitlab, none)
```

## Configuration

`ng-checkup.config.json` in the project root. Every key is optional, and every command-line flag overrides its key.

```json
{
  "reports": ["checkup.html"],
  "failOn": "poor",
  "maxExamples": 5,
  "offline": false,
  "ignore": ["src/legacy", "**/generated", "apps/*/e2e"]
}
```

| Key | Meaning | Flag |
| --- | --- | --- |
| `reports` | report files to write, relative to the config file | `--report` |
| `failOn` | exit with 1 when an area is `poor` (or `fair`), or with `regression` when a measure is worse than the baseline | `--fail-on` |
| `maxExamples` | example files listed per finding | `--max-examples` |
| `offline` | skip the npm lookup of the latest Angular version | `--offline` |
| `ignore` | paths left out of the analysis; a path matches everything below it, `*` stays within a folder, `**` crosses folders | |
| `baseline` | the baseline file, relative to the config file (default `ng-checkup.baseline.json` in the root) | |
| `plan` | add the upgrade plan to every run | `--plan` |

An unknown key or a wrong type stops the run with an error, so a typo cannot silently switch off a CI threshold. Use `--config path/to/file.json` for a file elsewhere.

## Baseline: adopt it on legacy code

A ten-year-old Angular app will not pass `--fail-on poor` on day one, and a CI check that is red from the start gets switched off. The baseline fixes that: it records today's numbers, and CI fails only when one of them gets worse.

```bash
npx ng-checkup baseline                    # writes ng-checkup.baseline.json; commit it
npx ng-checkup --fail-on regression        # in CI: fails only on a number that went up
```

```text
Baseline  2 worse
  worse  Type safety: Explicit any in application code 13 → 15
  worse  Type safety: Non-null assertions (x!) 0 → 1
```

- **It records counts, not grades:** explicit `any`, `x!`, files in import cycles, components without OnPush or a spec, NgModule-declared components, deprecated API uses, sanitizer bypasses, eager routes and [24 more](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#measures). Lower is better for every one.
- **It only goes down.** When numbers drop, the run says so; `npx ng-checkup baseline` locks the new numbers in. If a number went up, `baseline` refuses and lists it, so a regression cannot be waved through by re-running the command. `--force` accepts it, which is the moment someone has to explain why in review.
- **It is a plain, sorted JSON file**, so lowering a number is a one-line diff in a merge request.
- **The gap to the latest Angular is not in it.** That grows when Angular ships, not when the code gets worse.

`ng add ng-checkup` and `npx ng-checkup init` create the first baseline and set CI to `--fail-on regression` for you.

## Watch mode

```bash
npx ng-checkup --watch
```

Re-runs on every save and prints, under the usual summary, how the score and every measure moved since the watch started:

```text
Score 72 -> 76 (+4 since the watch started)
  down Explicit any: 41 -> 37
  down Components without OnPush: 12 -> 11
```

Only the changed files are parsed again, and the registry is asked again only when `package.json` or a lockfile changes, so a run after a save takes a fraction of the first one. Keep it open next to the editor while working through a refactor; run `npx ng-checkup baseline` in another terminal to lock a drop in, and the next run compares against it.

## Upgrade plan

```bash
npx ng-checkup --plan --report plan.md
```

`--plan` adds the way from your Angular version to the latest, one major at a time as `ng update` requires:

```text
Upgrade plan  12 → 22, 10 steps, one major at a time
  Before you start
    · Move from TSLint to ESLint  ng add @angular-eslint/schematics
  → 13  ng update @angular/core@13 @angular/cli@13
        Node.js ^12.20.0 || ^14.15.0 || >=16.10.0 · TypeScript >=4.4.2 <4.7 (now 4.3.5)
  ...
  → 16  ng update @angular/core@16 @angular/cli@16
        Node.js ^16.14.0 || >=18.10.0 · TypeScript >=4.9.3 <5.2 · zone.js ~0.13.0 (now 0.11.8)
        · Convert NgModule components to standalone (18)  ng generate @angular/core:standalone
  → 17  ng update @angular/core@17 @angular/cli@17
        · Move templates to built-in control flow (13)  ng generate @angular/core:control-flow
  ...
```

- **The same for everyone:** each step's `ng update` command (with Material and NgRx when you use them) and the Node.js, TypeScript, RxJS and zone.js ranges that major requires, from the versions' published package metadata. A range your project is outside of today is flagged at the step that has to move it.
- **Specific to your code:** the migrations your findings call for (standalone, built-in control flow, the esbuild builder, signal inputs, Vitest, zoneless), each scheduled at the first step where Angular ships it, with the number of places it touches. Migrations your code does not need are left out.
- **No time estimate.** Counts are measured; days would be a guess.

The plan is in every format, including the HTML report ([example](https://stefankuburovic.github.io/ng-checkup/example.html#plan-title)) and the JSON (`report.plan`).

## Monorepos

In an Angular CLI workspace with several projects or an Nx workspace, the report adds a table with one row per project, worst score first (here [nx-examples](https://github.com/nrwl/nx-examples), shortened):

```text
Projects  5, worst first, graded on their own code
   65  products            apps/products            poor: Change detection & zoneless readiness, Components & templates, Type safety  fair: State management
   80  products-home-page  libs/products/home-page  poor: Type safety  fair: Components & templates, State management
   80  shared-cart-state   libs/shared/cart/state   poor: Type safety  fair: State management
```

Each project is graded on the files it owns (a nested library keeps its own) with its own tsconfig. The Angular version and the third-party packages are shared, so they are graded once, for the workspace. Projects that import nothing from Angular (React apps, Node services, Cypress e2e folders) get no row.

`--project <name>` narrows the whole report to one project, which is how a team owning one app runs it in CI:

```bash
npx ng-checkup --project admin --report admin.html
```

The baseline always covers the whole workspace, so `--project` runs do not compare against it.

## What it checks

| Area | It looks at | Poor when |
| --- | --- | --- |
| [**Angular version & tooling**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#version) | installed vs. latest Angular, mixed `@angular/*` majors, webpack builder, end-of-life packages | three or more majors behind, i.e. out of support |
| [**Deprecated APIs**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#deprecated-apis) | every imported Angular/NgRx symbol your **installed** version tags `@deprecated`, plus `*ngIf` / `*ngFor` in templates | something deprecated two majors ago is still used |
| [**Third-party compatibility**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#dependencies) | the `@angular/core` peer range of every installed package (PrimeNG, Kendo, ng-bootstrap, NGXS, ...), the release that supports the next majors, npm deprecations | a package does not accept the installed Angular, or no release supports the latest |
| [**Change detection**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#change-detection) | zoneless or zone.js, OnPush coverage, `NgZone`, zone-only test helpers | zone.js with less than half the components on OnPush |
| [**Components & templates**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#components) | standalone, signal inputs and outputs, built-in control flow, `@defer` | average adoption below 40% |
| [**State management**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#state) | classic NgRx, NgRx signal store, signals, `BehaviorSubject` services | the removed `@Effect()` decorator |
| [**Architecture**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#architecture) | eager vs. lazy routes (following `loadChildren` into lazy modules), files over 500 and 1 000 lines, constructor injection, class-based guards and interceptors | ten eager routes and none lazy, or three files over 1 000 lines |
| [**Testing**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#testing) | Karma / Jest / Vitest, specs next to components and services, Protractor / Playwright / Cypress | Karma, Protractor or no specs |
| [**Type safety**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#type-safety) | `strictNullChecks`, `strictTemplates`, `noImplicitAny`, `any`, `x!`, `@ts-ignore`, `$any()` | both `strictNullChecks` and `strictTemplates` off |
| [**Security**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#security) | `bypassSecurityTrust*`, HTML written straight into the DOM (`innerHTML =`, `insertAdjacentHTML`, `Renderer2.setProperty`), `eval`, `[innerHTML]` bindings | HTML written into the DOM past the sanitizer, or `eval` |
| [**Circular dependencies**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#circular-deps) | import cycles through relative paths, barrels and tsconfig `paths` | more than three groups or ten files in loops |
| [**Bundle size**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#bundle) | the initial bundle from the last `ng build --stats-json` (esbuild or webpack) against the build's budget, its largest packages, lazy chunks | over the `initial` error budget (1 MB by default) |

Each finding says why it matters and which `ng generate` migration fixes it. **[Every check, its grading and its fix →](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md)**

Defaults that changed between versions are applied per version: a component without `standalone` is standalone from Angular 19, one without `changeDetection` is OnPush from 22, and an app without a zone provider is zoneless from 21.

## Reports

![The HTML report](https://raw.githubusercontent.com/stefankuburovic/ng-checkup/main/docs/report.png)

| Command | Output |
| --- | --- |
| `npx ng-checkup` | summary and top five priorities in the terminal |
| `npx ng-checkup --verbose` | every finding with its files in the terminal |
| `npx ng-checkup --report checkup.html` | self-contained page: light and dark mode, prints cleanly to PDF, loads nothing from the network |
| `npx ng-checkup --report checkup.md` | Markdown for a pull request, an issue or a wiki |
| `npx ng-checkup --report checkup.json` | everything, machine-readable |
| `npx ng-checkup --report checkup.sarif` | SARIF 2.1.0 for [GitHub code scanning](#in-ci) and other SARIF viewers |
| `npx ng-checkup --json` | the JSON on stdout, for piping |

`--report` is repeatable, so one run can write all three files.

<details>
<summary>All options</summary>

```text
Usage: ng-checkup [path] [options]
       ng-checkup init [path] [init options]
       ng-checkup baseline [path] [--force]

Arguments:
  path                   Repository root (default: current directory)

Options:
  -r, --report <file>    Write the full report; format from the extension:
                         .html, .md, .json or .sarif (GitHub code scanning).
                         Repeatable.
      --json             Print the report as JSON to stdout instead of the summary
  -v, --verbose          Print every finding with its files
      --plan             Add an upgrade plan to the latest Angular, one major
                         at a time, with the migrations this code needs
  -p, --project <name>   Analyse one project of an Angular CLI or Nx workspace.
                         Without it, a multi-project workspace also gets a
                         per-project table
  -w, --watch            Re-run on every change and show how the score and the
                         measures moved since the watch started
      --fail-on <grade>  Exit with code 1 if any area is graded <grade> or worse
                         (poor or fair), or with regression if a measure is
                         worse than the baseline (for CI)
      --max-examples <n> Example files listed per finding (default 5)
      --offline          Do not look up the latest Angular version online
      --config <file>    Config file (default: ng-checkup.config.json in the root)
      --no-color         Plain output (also off when NO_COLOR is set or not a TTY)
  -h, --help             Show this help
      --version          Show the version

Init options (ng-checkup init):
      --ci <provider>    auto (default), github, gitlab or none
      --dry-run          Show what would change without writing anything
      --force            Replace an existing "checkup" script

Baseline options (ng-checkup baseline):
      --force            Accept measures that went up since the last baseline
```

Exit codes: `0` done, `1` `--fail-on` tripped, `2` usage error (including `--fail-on regression` without a baseline). Areas graded `info` never fail a run.

</details>

## In CI

`ng add ng-checkup` and `npx ng-checkup init` write this for you. By hand:

**GitHub Actions**

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npm ci
- run: npx ng-checkup --fail-on regression --report checkup.md --report checkup.html
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: ng-checkup
    path: checkup.*
```

**GitLab CI**

```yaml
ng-checkup:
  image: node:22
  script:
    - npm ci
    - npx ng-checkup --fail-on regression --report checkup.md --report checkup.html
  artifacts:
    when: always
    paths: [checkup.md, checkup.html]
```

**GitHub code scanning**

`--report ng-checkup.sarif` writes [SARIF](https://sarifweb.azurewebsites.net/), so findings show up as annotations on the changed lines of a pull request and in the Security tab:

```yaml
permissions:
  security-events: write
steps:
  - uses: actions/checkout@v4
  - run: npm ci
  - run: npx ng-checkup --offline --max-examples 1000 --report ng-checkup.sarif
  - uses: github/codeql-action/upload-sarif@v3
    if: always()
    with:
      sarif_file: ng-checkup.sarif
      category: ng-checkup
```

One rule per area, so alerts survive a rerun; a finding about the whole project (the Angular version, a package that blocks the upgrade) is placed on `package.json`. `--max-examples` decides how many locations each finding reports. Code scanning is free on public repositories and needs GitHub Advanced Security on private ones.

On an existing codebase, start with a [baseline](#baseline-adopt-it-on-legacy-code) and `--fail-on regression`. `--fail-on poor` and `--fail-on fair` are for codebases that are already in good shape and want to stay there.

## Programmatic API

```ts
import { writeFile } from 'node:fs/promises';
import { runCheckup, renderMarkdown, overallScore } from 'ng-checkup';

const report = await runCheckup('path/to/app', { offline: true });

console.log(overallScore(report)); // e.g. 45
for (const check of report.checks) {
  console.log(check.id, check.grade, check.summary);
}

// The same Markdown the CLI writes, e.g. to post as a pull-request comment.
await writeFile('checkup.md', renderMarkdown(report));
```

`runCheckup` never writes anything. Its options mirror the flags (`offline`, `plan`, `project`, `ignore`, `maxExamples`), plus `cache` from `createAnalysisCache()` to make repeated runs incremental. `renderHtml`, `renderMarkdown`, `renderSarif`, `overallScore`, `topPriorities`, `loadConfig`, `planInit` (what `init` would change, without writing it) and the baseline functions (`createBaseline`, `compareWithBaseline`, `readBaseline`, `serializeBaseline`) are exported too, along with the `Report`, `CheckResult`, `Finding` and `Grade` types. `Report` is also the schema of the JSON output.

## What leaves your machine

Package names, and only to the public npm registry: the latest `@angular/core` version (three-second timeout), and for every installed third-party package that depends on Angular, its public metadata, to find the release that supports the next Angular and whether it is deprecated (eight at a time, four-second timeout each). `--offline` skips all of it: the report then compares against the newest major this release knows and says so. No source, no file names, no telemetry. The tool reads files and writes only the reports you ask for.

## How it works

- **Syntax only.** Every `.ts` file is parsed once with the TypeScript compiler API, without a type checker and without building your project. That is why it takes seconds on a large monorepo and works on a repository that does not compile. Identifiers are matched through their imports, so a local helper called `signal` is not counted as Angular's.
- **Deprecations come from your `node_modules`.** It reads the `@deprecated` tags in the installed `@angular/*` and `@ngrx/*` type definitions, following Angular's re-exports between its bundled `.d.ts` chunks, in both the current package layout and the older one. The report always matches the version you actually run, in Angular's own words.
- **Cycles are counted as groups.** A strongly connected component is one thing to untangle; counting individual cycles grows combinatorially.

## FAQ

**Does it change my code?** No. It only reads. The fixes it suggests are Angular's own `ng generate` migrations, which you run yourself.

**Why is the deprecated-API check "info"?** Dependencies are not installed. Run `npm install` and run the checkup again.

**My app is on Angular 12 and deprecated APIs are "good". Is that right?** Yes, for Angular 12: nothing that *Angular 12* deprecates is in use. Each upgrade step deprecates more, and the version check is where that gap shows.

**Is "with a spec" my test coverage?** No. It counts components and services with an `x.spec.ts` next to `x.ts`. It needs no test run, which is what keeps the tool fast and usable on a repository it has never seen.

**Does it support Nx?** Yes: it reads `project.json` targets and tsconfig `paths`, and reports [each project separately](#monorepos) as well as the whole workspace.

**Does it need RxJS or NgRx?** No. Checks report what they find: an app without RxJS has nothing for the RxJS deprecations to flag, and one without a state library is graded on signals and services. Other libraries (NGXS, Akita, PrimeNG, Kendo, Material) are covered where it matters for an upgrade, through their Angular peer ranges in the third-party check.

**Why is bundle size "info"?** It reads the stats file of your last build instead of running one. `ng build --stats-json` writes it; run the checkup after that.

**Which Angular versions?** Angular 2 and newer (not AngularJS). Checks whose rules changed between versions (standalone, OnPush, zoneless defaults) apply the rules of the version you run.

## Roadmap

- Per-project baselines for monorepos
- Change frequency from git history, to rank large files by how often they change
- A VS Code extension showing findings inline

Ideas and bug reports are welcome in [issues](https://github.com/stefankuburovic/ng-checkup/issues).

## Contributing

```bash
git clone https://github.com/stefankuburovic/ng-checkup.git
cd ng-checkup
npm install
npm test            # builds, then runs the Vitest suite against the fixture apps in test/fixtures
npm run typecheck
node dist/cli.js path/to/some/angular/app
```

Each check is one file in `src/checks/` and a pure function of the analysis context, so a new check is a new file plus a fixture that shows it.

## Need help acting on the report?

I'm [Stefan Kuburovic](https://stefankuburovic.github.io/), and modernizing large Angular codebases is my job. If you'd rather have someone walk through the report with your team, or do the upgrade with you, have a look at the [Angular Health Check](https://stefankuburovic.github.io/#health-check).

## License

MIT
