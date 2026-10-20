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

# 3. Fail CI when an area turns poor
npx ng-checkup --fail-on poor
```

Install dependencies first (`npm install`) if you can: the deprecated-API check reads the installed Angular packages, and without them it is skipped.

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

Arguments:
  path                   Repository root (default: current directory)

Options:
  -r, --report <file>    Write the full report; format from the extension:
                         .html, .md or .json. Repeatable.
      --json             Print the report as JSON to stdout instead of the summary
  -v, --verbose          Print every finding with its files
      --fail-on <grade>  Exit with code 1 if any area is graded <grade> or worse:
                         poor or fair (for CI)
      --max-examples <n> Example files listed per finding (default 5)
      --offline          Do not look up the latest Angular version online
      --no-color         Plain output (also off when NO_COLOR is set or not a TTY)
  -h, --help             Show this help
      --version          Show the version
```

Exit codes: `0` done, `1` `--fail-on` tripped, `2` usage error. Areas graded `info` never fail a run.

</details>

## In CI

**GitHub Actions**

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npm ci
- run: npx ng-checkup --fail-on poor --report checkup.md --report checkup.html
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
    - npx ng-checkup --fail-on poor --report checkup.md --report checkup.html
  artifacts:
    when: always
    paths: [checkup.md, checkup.html]
```

Start with `--fail-on poor`. `--fail-on fair` is for codebases that are already in good shape and want to stay there.

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

`runCheckup` never writes anything. `renderHtml`, `renderMarkdown`, `overallScore` and `topPriorities` are exported too, along with the `Report`, `CheckResult`, `Finding` and `Grade` types. `Report` is also the schema of the JSON output.

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

- `ng-checkup init` and `ng add ng-checkup`: a `checkup` script, a config file and a CI step in one command
- Baseline mode: fail CI only when a number gets worse, so legacy code can adopt it on day one
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
