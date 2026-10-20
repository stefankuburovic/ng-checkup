# ng-checkup

[![npm](https://img.shields.io/npm/v/ng-checkup)](https://www.npmjs.com/package/ng-checkup) [![CI](https://github.com/stefankuburovic/ng-checkup/actions/workflows/ci.yml/badge.svg)](https://github.com/stefankuburovic/ng-checkup/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/stefankuburovic/ng-checkup/blob/main/LICENSE)

**A one-minute modernization report for any Angular codebase.**

Point it at a repository and it tells you how far the code is from current Angular, what will break on the next upgrade, and where the work is. Eight areas get a grade, every finding names the files, and the HTML report is one self-contained page you can hand to your team lead.

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

- **It records counts, not grades:** explicit `any`, `x!`, files in import cycles, components without OnPush or a spec, NgModule-declared components, deprecated API uses and [18 more](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#measures). Lower is better for every one.
- **It only goes down.** When numbers drop, the run says so; `npx ng-checkup baseline` locks the new numbers in. If a number went up, `baseline` refuses and lists it, so a regression cannot be waved through by re-running the command. `--force` accepts it, which is the moment someone has to explain why in review.
- **It is a plain, sorted JSON file**, so lowering a number is a one-line diff in a merge request.
- **The gap to the latest Angular is not in it.** That grows when Angular ships, not when the code gets worse.

`ng add ng-checkup` and `npx ng-checkup init` create the first baseline and set CI to `--fail-on regression` for you.

## What it checks

| Area | It looks at | Poor when |
| --- | --- | --- |
| [**Angular version & tooling**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#version) | installed vs. latest Angular, mixed `@angular/*` majors, webpack builder, end-of-life packages | three or more majors behind, i.e. out of support |
| [**Deprecated APIs**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#deprecated-apis) | every imported Angular/NgRx symbol your **installed** version tags `@deprecated`, plus `*ngIf` / `*ngFor` in templates | something deprecated two majors ago is still used |
| [**Change detection**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#change-detection) | zoneless or zone.js, OnPush coverage, `NgZone`, zone-only test helpers | zone.js with less than half the components on OnPush |
| [**Components & templates**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#components) | standalone, signal inputs and outputs, built-in control flow, `@defer` | average adoption below 40% |
| [**State management**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#state) | classic NgRx, NgRx signal store, signals, `BehaviorSubject` services | the removed `@Effect()` decorator |
| [**Testing**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#testing) | Karma / Jest / Vitest, specs next to components and services, Protractor / Playwright / Cypress | Karma, Protractor or no specs |
| [**Type safety**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#type-safety) | `strictNullChecks`, `strictTemplates`, `noImplicitAny`, `any`, `x!`, `@ts-ignore`, `$any()` | both `strictNullChecks` and `strictTemplates` off |
| [**Circular dependencies**](https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md#circular-deps) | import cycles through relative paths, barrels and tsconfig `paths` | more than three groups or ten files in loops |

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
                         .html, .md or .json. Repeatable.
      --json             Print the report as JSON to stdout instead of the summary
  -v, --verbose          Print every finding with its files
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

`runCheckup` never writes anything. `renderHtml`, `renderMarkdown`, `overallScore`, `topPriorities`, `loadConfig`, `planInit` (what `init` would change, without writing it) and the baseline functions (`createBaseline`, `compareWithBaseline`, `readBaseline`, `serializeBaseline`) are exported too, along with the `Report`, `CheckResult`, `Finding` and `Grade` types. `Report` is also the schema of the JSON output.

## What leaves your machine

One request: the latest `@angular/core` version from the npm registry, with a three-second timeout. `--offline` skips it and compares against the newest major this release knows, and the report says so. No source, no file names, no telemetry. The tool reads files and writes only the reports you ask for.

## How it works

- **Syntax only.** Every `.ts` file is parsed once with the TypeScript compiler API, without a type checker and without building your project. That is why it takes seconds on a large monorepo and works on a repository that does not compile. Identifiers are matched through their imports, so a local helper called `signal` is not counted as Angular's.
- **Deprecations come from your `node_modules`.** It reads the `@deprecated` tags in the installed `@angular/*` and `@ngrx/*` type definitions, following Angular's re-exports between its bundled `.d.ts` chunks, in both the current package layout and the older one. The report always matches the version you actually run, in Angular's own words.
- **Cycles are counted as groups.** A strongly connected component is one thing to untangle; counting individual cycles grows combinatorially.

## FAQ

**Does it change my code?** No. It only reads. The fixes it suggests are Angular's own `ng generate` migrations, which you run yourself.

**Why is the deprecated-API check "info"?** Dependencies are not installed. Run `npm install` and run the checkup again.

**My app is on Angular 12 and deprecated APIs are "good". Is that right?** Yes, for Angular 12: nothing that *Angular 12* deprecates is in use. Each upgrade step deprecates more, and the version check is where that gap shows.

**Is "with a spec" my test coverage?** No. It counts components and services with an `x.spec.ts` next to `x.ts`. It needs no test run, which is what keeps the tool fast and usable on a repository it has never seen.

**Does it support Nx?** Yes: it reads `project.json` targets and tsconfig `paths`. A workspace with several apps is reported as one codebase for now.

**Which Angular versions?** Angular 2 and newer (not AngularJS). Checks whose rules changed between versions (standalone, OnPush, zoneless defaults) apply the rules of the version you run.

## Roadmap

- Upgrade plan: the steps from your version to the latest, with the migrations each needs
- Per-project reports for Nx and multi-project workspaces
- Bundle size from the build's esbuild metafile
- SARIF output for GitHub code scanning

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
